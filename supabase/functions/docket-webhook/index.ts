// docket-webhook: receives docket events from Castle and routes to DCC
// Auth: HMAC-SHA256 of raw body using shared secret DOCKET_WEBHOOK_SECRET
// Contract: see CASTLE_DOCKET_INTEGRATION.md in the DCC repo
//
// NOTE: deployed with verify_jwt=false. The Supabase API gateway does NOT
// require a JWT for POSTs to this endpoint — HMAC signature verification
// inside the function body is the ONLY auth check. Castle has no Supabase
// session; it signs requests with the shared secret. See
// docs/DCC_GO_LIVE_HANDOFF.md §1 in the Castle v2 repo for rationale.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

const REQUIRED = ['external_id', 'case_number', 'county', 'event_type', 'event_date', 'description'];

const CLIENT_FACING_EVENTS = new Set([
  'disbursement_ordered',
  'disbursement_paid',
  'hearing_scheduled',
  'hearing_continued',
  'judgment_entered',
]);

const ALERT_EVENTS = new Set([
  'notice_of_claim',
  'objection_filed',
]);

const PAYOUT_TRIGGER_EVENTS = new Set([
  'disbursement_ordered',
  'disbursement_paid',
]);

function hexFromArrayBuffer(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function hmacSha256(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return hexFromArrayBuffer(sig);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

serve(async (req: Request) => {
  // CORS for potential browser-based testing (optional)
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Signature',
      },
    });
  }

  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  const secret = Deno.env.get('DOCKET_WEBHOOK_SECRET');
  if (!secret) {
    console.error('DOCKET_WEBHOOK_SECRET not configured');
    return json(500, { error: 'webhook_not_configured' });
  }

  const rawBody = await req.text();
  const sigHeader = req.headers.get('X-Signature') || '';

  // X-Signature format: sha256=<hex>
  const [algo, providedSig] = sigHeader.split('=');
  if (algo !== 'sha256' || !providedSig) {
    return json(401, { error: 'bad_signature_format' });
  }

  const expectedSig = await hmacSha256(secret, rawBody);
  if (!timingSafeEqual(providedSig, expectedSig)) {
    return json(401, { error: 'bad_signature' });
  }

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  // Validate required fields
  for (const f of REQUIRED) {
    if (!event[f]) return json(400, { error: `missing_${f}` });
  }

  // Service-role client for cross-RLS writes
  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  // Match case_number + county to a deal via meta.courtCase / meta.county
  const { data: matches, error: matchErr } = await sb
    .from('deals')
    .select('id, name, status, meta')
    .eq('meta->>courtCase', event.case_number as string)
    .eq('meta->>county', event.county as string)
    .limit(2);

  if (matchErr) {
    console.error('match_query_failed', matchErr);
    return json(500, { error: 'match_query_failed', details: matchErr.message });
  }

  const dealCount = matches?.length || 0;

  // ─── No match: stash in unmatched staging ────────────────
  if (dealCount === 0) {
    const rawObjUnmatched = (event.raw as Record<string, unknown>) || {};
    const { error: stageErr } = await sb.from('docket_events_unmatched').upsert(
      {
        external_id: event.external_id,
        case_number: event.case_number,
        county: event.county,
        court_system: event.court_system,
        event_type: event.event_type,
        event_date: event.event_date,
        description: event.description,
        document_url: event.document_url,
        raw: event.raw || {},
        detected_at: event.detected_at,
        castle_case_id: event.castle_case_id,
        is_backfill: rawObjUnmatched.backfill === true,
        // Castle's Apr 25 sprint additions — additive, may be undefined on older payloads
        litigation_stage: (event as any).litigation_stage ?? null,
        deadline_metadata: (event as any).deadline_metadata ?? null,
        attorney_appearance: (event as any).attorney_appearance ?? null,
      },
      { onConflict: 'external_id', ignoreDuplicates: true }
    );
    if (stageErr) {
      console.error('stage_insert_failed', stageErr);
      return json(500, { error: 'stage_insert_failed', details: stageErr.message });
    }
    return json(200, { accepted: true, unmatched: true });
  }

  // Castle flags backfill runs by setting raw.backfill = true on every
  // event. We mirror that onto the is_backfill column and pre-acknowledge
  // so the notification trigger + UI don't treat 53 historical events as
  // 53 fresh notifications. See docs/DCC_GO_LIVE_HANDOFF.md §4 Option B.
  const rawObj = (event.raw as Record<string, unknown>) || {};
  const isBackfill = rawObj.backfill === true;
  const nowIso = new Date().toISOString();

  // ─── Insert event for each matching deal ─────────────────
  const insertedDealIds: string[] = [];
  let anyDuplicate = false;
  for (const deal of matches!) {
    const { error: insertErr } = await sb.from('docket_events').insert({
      deal_id: deal.id,
      external_id: event.external_id,
      case_number: event.case_number,
      county: event.county,
      court_system: event.court_system,
      event_type: event.event_type,
      event_date: event.event_date,
      description: event.description,
      document_url: event.document_url,
      raw: event.raw || {},
      detected_at: event.detected_at,
      castle_case_id: event.castle_case_id,
      is_backfill: isBackfill,
      acknowledged_at: isBackfill ? nowIso : null,
      // Castle's Apr 25 sprint additions — additive, may be undefined on older payloads
      litigation_stage: (event as any).litigation_stage ?? null,
      deadline_metadata: (event as any).deadline_metadata ?? null,
      attorney_appearance: (event as any).attorney_appearance ?? null,
    });

    if (insertErr) {
      // Duplicate external_id for this deal → 409-like response (idempotent)
      if (insertErr.code === '23505' /* unique_violation */) {
        anyDuplicate = true;
        continue;
      }
      console.error('insert_failed', insertErr);
      return json(500, { error: 'insert_failed', details: insertErr.message });
    }

    insertedDealIds.push(deal.id);

    // Write activity row so the team feed picks it up.
    // Team-only by default; the portals read docket_events directly for
    // their Court Activity sections so clients/attorneys see the event
    // through that channel, not via the activity audit log.
    const prefix = event.event_type === 'docket_updated' ? 'Docket' : `Docket · ${event.event_type}`;
    await sb.from('activity').insert({
      deal_id: deal.id,
      user_id: null,
      action: `${prefix}: ${event.description}`,
      visibility: ['team'],
    });

    // TODO (future): trigger payout workflow on PAYOUT_TRIGGER_EVENTS
    // TODO (future): send Nathan alert on ALERT_EVENTS
    // TODO (future): kick off document OCR if document_url present
  }

  if (insertedDealIds.length === 0 && anyDuplicate) {
    return json(200, { accepted: true, duplicate: true });
  }

  return json(200, {
    accepted: true,
    deal_ids: insertedDealIds,
    event_type: event.event_type,
    client_facing: CLIENT_FACING_EVENTS.has(event.event_type as string),
    alert: ALERT_EVENTS.has(event.event_type as string),
    payout_trigger: PAYOUT_TRIGGER_EVENTS.has(event.event_type as string),
    is_backfill: isBackfill,
  });
});
