// attach-docket-pdf
//
// Fetches the PDF for a newly-ingested docket event, uploads it into
// deal-docs storage, creates a documents row (triggering Claude Vision OCR),
// and links back to the docket event via document_ocr_id.
//
// Called by a Postgres trigger (pg_net) on docket_events INSERT when:
//   - document_url is not null
//   - document_ocr_id is null (not already attached)
//   - is_backfill is false (don't retroactively fetch historical PDFs)
//
// Input:  { docket_event_id: uuid }
// Auth:   shared secret in X-Attach-Docket-PDF-Secret header (set via vault)
//
// Failure modes handled gracefully:
//   - Court site blocks fetch → log, return 200 (don't retry; manual upload works)
//   - Storage upload fails     → log, return 500 (trigger retries on next insert)
//   - Document already attached → no-op (idempotent)

import { createClient } from 'jsr:@supabase/supabase-js@2';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });

  const secret = Deno.env.get('ATTACH_DOCKET_PDF_SECRET');
  if (!secret) return new Response(JSON.stringify({ error: 'ATTACH_DOCKET_PDF_SECRET not configured' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  if (req.headers.get('X-Attach-Docket-PDF-Secret') !== secret) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }

  try {
    const { docket_event_id } = await req.json();
    if (!docket_event_id) return new Response(JSON.stringify({ error: 'docket_event_id required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const db = createClient(supabaseUrl, serviceKey);

    const { data: event } = await db.from('docket_events')
      .select('id, deal_id, document_url, document_ocr_id, event_type, event_date, description, is_backfill, court_system, county')
      .eq('id', docket_event_id).single();
    if (!event) return new Response(JSON.stringify({ error: 'event not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    if (!event.document_url || event.is_backfill || event.document_ocr_id) {
      return new Response(JSON.stringify({ skipped: true, reason: !event.document_url ? 'no url' : event.is_backfill ? 'backfill' : 'already attached' }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (!event.deal_id) return new Response(JSON.stringify({ skipped: true, reason: 'no deal (unmatched event)' }), { headers: { 'Content-Type': 'application/json' } });

    // Fetch the PDF. Courts can be finicky; send a realistic User-Agent and
    // the host as Referer. If Cloudflare or auth blocks, we degrade gracefully:
    // return 200, leave document_ocr_id null, the existing "View court document"
    // link still works.
    let pdfBytes: Uint8Array | null = null;
    let fetchError: string | null = null;
    try {
      const origin = new URL(event.document_url).origin;
      const resp = await fetch(event.document_url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
          'Accept': 'application/pdf,*/*',
          'Referer': origin + '/',
        },
        redirect: 'follow',
      });
      if (!resp.ok) {
        fetchError = `fetch HTTP ${resp.status}`;
      } else {
        const ct = resp.headers.get('content-type') || '';
        if (!/pdf|octet-stream/i.test(ct)) {
          fetchError = `unexpected content-type: ${ct}`;
        } else {
          pdfBytes = new Uint8Array(await resp.arrayBuffer());
        }
      }
    } catch (e) {
      fetchError = (e as Error).message;
    }

    if (!pdfBytes) {
      // Log and move on. Nathan's existing "View court document →" link still
      // works; he can also manually upload the PDF on the Files tab.
      return new Response(JSON.stringify({ skipped: true, reason: 'fetch_failed', error: fetchError }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Build a filename that reads nicely when Nathan sees it on the Files tab
    const evtTypeClean = (event.event_type || 'docket').replace(/_/g, '-');
    const dateStr = event.event_date || new Date().toISOString().slice(0, 10);
    const filename = `docket-${evtTypeClean}-${dateStr}.pdf`;
    const path = `${event.deal_id}/docket/${event.id}.pdf`;

    const { error: uploadErr } = await db.storage.from('deal-docs')
      .upload(path, pdfBytes, { contentType: 'application/pdf', upsert: true });
    if (uploadErr) {
      return new Response(JSON.stringify({ error: 'storage_upload_failed', details: uploadErr.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    const { data: doc, error: docErr } = await db.from('documents').insert({
      deal_id: event.deal_id,
      name: filename,
      path,
      size: pdfBytes.byteLength,
      uploaded_by: null,
      extraction_status: 'pending',
    }).select('id').single();
    if (docErr) {
      return new Response(JSON.stringify({ error: 'documents_insert_failed', details: docErr.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    // Link back on the docket event row
    await db.from('docket_events').update({ document_ocr_id: doc.id }).eq('id', event.id);

    // Kick off Claude Vision OCR so extracted.fields + summary populate the
    // Case Intelligence card. Fire and forget — OCR takes 5-15 sec.
    try {
      await fetch(`${supabaseUrl}/functions/v1/extract-document`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ document_id: doc.id }),
      });
    } catch (_) { /* non-fatal */ }

    return new Response(JSON.stringify({
      attached: true,
      document_id: doc.id,
      filename,
      size: pdfBytes.byteLength,
    }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
});
