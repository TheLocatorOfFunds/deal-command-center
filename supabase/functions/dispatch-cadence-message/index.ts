// dispatch-cadence-message
//
// Cadence-engine consumer. pg_cron's fire_scheduled_outreach() walks the
// outreach_queue every 15 min and POSTs here for each row that's due.
//
// Flow:
//   1. Auth via X-Cadence-Secret header (matches vault.cadence_engine_secret)
//   2. Re-load the queue row (race-safe — pg_cron may have called us seconds
//      ago, status could've changed)
//   3. Re-check DNC (someone may have replied STOP since pg_cron filtered)
//   4. Re-check status='pending' + cadence_day >= 1 + draft_body present
//   5. Call send-sms with the draft body
//   6. Mark status='sent' + sent_at + message_id
//   7. Schedule the next cadence row if applicable (Day 1 → Day 3 → Day 5 →
//      Day 12 → +7d through Day 90)
//
// Owner note for Justin's Claude session: this is net-new infrastructure
// shipped from Nathan's session 2026-04-25. Mirrors the same auth pattern
// as morning-sweep / castle-health-daily. Doesn't modify any of your
// existing tables — only inserts new outreach_queue rows for follow-ups.
//
// Cadence ladder (Nathan-set 2026-04-25):
//   Day 0 → human-gated, NOT auto-fired by pg_cron
//   Day 1, 3, 5 → urgent week-1
//   Day 12, 19, 26, 33, 40, 47, 54, 61, 68, 75, 82, 90 → weekly drip
//   Day 90+ → drop, no further outbound

import { createClient } from 'jsr:@supabase/supabase-js@2';

// ──────────────────────────────────────────────────────────────
// Cadence ladder
// ──────────────────────────────────────────────────────────────

// Returns the next cadence_day after the given one, or null if cadence
// has finished. Used to schedule the follow-up row after a successful send.
function nextCadenceDay(current: number): number | null {
  const ladder = [0, 1, 3, 5, 12, 19, 26, 33, 40, 47, 54, 61, 68, 75, 82, 90];
  const idx = ladder.indexOf(current);
  if (idx < 0 || idx >= ladder.length - 1) return null;
  return ladder[idx + 1];
}

function dayMs(days: number): number {
  return days * 24 * 60 * 60 * 1000;
}

// ──────────────────────────────────────────────────────────────
// Handler
// ──────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const secret = Deno.env.get('CADENCE_ENGINE_SECRET');
  if (!secret) return json({ error: 'CADENCE_ENGINE_SECRET not configured' }, 503);
  if (req.headers.get('X-Cadence-Secret') !== secret) return json({ error: 'Unauthorized' }, 401);

  try {
    const { queue_id } = await req.json();
    if (!queue_id) return json({ error: 'queue_id required' }, 400);

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const sb = createClient(supabaseUrl, serviceKey);

    // ── Race-safe re-validation ─────────────────────────────
    const { data: q, error: qErr } = await sb.from('outreach_queue')
      .select('id, deal_id, contact_phone, cadence_day, draft_body, status, scheduled_for')
      .eq('id', queue_id)
      .single();
    if (qErr || !q) return json({ error: 'queue row not found', details: qErr?.message }, 404);
    if (q.status !== 'pending') return json({ skipped: true, reason: `status=${q.status}` });
    if (!q.draft_body) return json({ skipped: true, reason: 'no draft_body' });
    if (q.cadence_day < 1) return json({ skipped: true, reason: 'cadence_day=0 is human-gated' });
    if (!q.contact_phone) return json({ skipped: true, reason: 'no contact_phone' });

    // ── DNC re-check (someone may have hit STOP since pg_cron filtered) ──
    const { data: dnc } = await sb.from('contacts')
      .select('id, do_not_text, dnd_reason')
      .eq('phone', q.contact_phone)
      .eq('do_not_text', true)
      .limit(1)
      .maybeSingle();
    if (dnc) {
      await sb.from('outreach_queue')
        .update({ status: 'cancelled', skipped_reason: `DNC (${dnc.dnd_reason || 'no reason'})`, updated_at: new Date().toISOString() })
        .eq('id', queue_id);
      return json({ skipped: true, reason: 'dnc_optout' });
    }

    // ── Fire send-sms ────────────────────────────────────────
    const sendResp = await fetch(`${supabaseUrl}/functions/v1/send-sms`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({
        to: q.contact_phone,
        body: q.draft_body,
        deal_id: q.deal_id,
      }),
    });
    const sendBody = await sendResp.json().catch(() => ({}));

    if (!sendResp.ok) {
      await sb.from('outreach_queue').update({
        status: 'failed',
        error_message: `send-sms HTTP ${sendResp.status}: ${JSON.stringify(sendBody).slice(0, 300)}`,
        updated_at: new Date().toISOString(),
      }).eq('id', queue_id);
      return json({ error: 'send_failed', details: sendBody }, 502);
    }

    // ── Mark as sent ─────────────────────────────────────────
    await sb.from('outreach_queue').update({
      status: 'sent',
      sent_at: new Date().toISOString(),
      message_id: sendBody.message_id || null,
      updated_at: new Date().toISOString(),
    }).eq('id', queue_id);

    // ── Schedule next cadence row ────────────────────────────
    const next = nextCadenceDay(q.cadence_day);
    if (next != null) {
      const nextScheduledFor = new Date(Date.now() + dayMs(next - q.cadence_day)).toISOString();
      await sb.from('outreach_queue').insert({
        deal_id: q.deal_id,
        contact_phone: q.contact_phone,
        cadence_day: next,
        status: 'queued',           // generate-outreach will pick this up + draft
        scheduled_for: nextScheduledFor,
      });
    }

    return json({
      ok: true,
      queue_id,
      cadence_day_sent: q.cadence_day,
      next_cadence_day: next,
      next_scheduled_for: next != null ? new Date(Date.now() + dayMs(next - q.cadence_day)).toISOString() : null,
    });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});

function json(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
