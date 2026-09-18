// morning-pulse — the daily heartbeat that reaches Nathan's PHONE.
//
// Born 2026-09-18 after the 18-day Anthropic outage: the canary alarmed
// daily into system_alerts, but alarms that live in a tab nobody opens
// are not alarms. This function compresses the business into one SMS,
// warnings first, and texts it to Nathan every morning.
//
// Also carries the Twilio balance canary (dependency report item): the
// only prepaid lifeline that previously had NO watcher. Balance below
// $20 raises a system_alert AND leads the SMS.
//
// Auth: POST with X-Pulse-Secret matching env PULSE_SECRET (pg_cron
// wrapper fire_morning_pulse() reads it from Vault - same pattern as
// ghl-sync). Env: PULSE_SECRET, PULSE_TO (default Nathan's cell),
// TWILIO_* (shared project secrets), SUPABASE_URL / SERVICE_ROLE_KEY.
// Sends via the send-sms EF so the message rides the normal outbound
// rail (messages_outbound row, delivery callbacks, 5440 sender).

import { createClient } from 'jsr:@supabase/supabase-js@2';

const TWILIO_LOW_BALANCE = 20; // dollars

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const secret = Deno.env.get('PULSE_SECRET') || '';
  if (!secret || req.headers.get('X-Pulse-Secret') !== secret) {
    return json({ error: 'unauthorized' }, 401);
  }

  const url = Deno.env.get('SUPABASE_URL')!;
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const db = createClient(url, key);
  const to = Deno.env.get('PULSE_TO') || '+15135162306';

  const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

  // ── Twilio balance (the missing canary) ─────────────────────────────
  let balance: number | null = null;
  try {
    const sid = Deno.env.get('TWILIO_ACCOUNT_SID')!;
    const tok = Deno.env.get('TWILIO_AUTH_TOKEN')!;
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Balance.json`, {
      headers: { Authorization: 'Basic ' + btoa(`${sid}:${tok}`) },
    });
    if (r.ok) balance = Number((await r.json()).balance);
  } catch (_) { /* balance stays null -> reported as unknown */ }

  if (balance !== null && balance < TWILIO_LOW_BALANCE) {
    const { data: open } = await db.from('system_alerts').select('id')
      .eq('source', 'twilio-balance').is('resolved_at', null).limit(1);
    if (!open?.length) {
      await db.from('system_alerts').insert({
        source: 'twilio-balance', severity: 'error',
        message: `Twilio balance low: $${balance.toFixed(2)} (threshold $${TWILIO_LOW_BALANCE}). Texting/calling dies when this hits zero - top up or enable auto-recharge.`,
      });
    }
  }

  // ── The numbers ─────────────────────────────────────────────────────
  const cnt = async (q: any) => (await q).count ?? 0;
  const [newDeals, review, queued, outTexts, inTexts, unread, alarms, aiDown] = await Promise.all([
    cnt(db.from('deals').select('id', { count: 'exact', head: true }).gte('created_at', dayAgo)),
    cnt(db.from('v_lead_review_queue').select('deal_id', { count: 'exact', head: true })),
    cnt(db.from('outreach_queue').select('id', { count: 'exact', head: true }).eq('status', 'pending')),
    cnt(db.from('messages_outbound').select('id', { count: 'exact', head: true }).eq('direction', 'outbound').gte('created_at', dayAgo)),
    cnt(db.from('messages_outbound').select('id', { count: 'exact', head: true }).eq('direction', 'inbound').gte('created_at', dayAgo)),
    cnt(db.from('messages_outbound').select('id', { count: 'exact', head: true }).eq('direction', 'inbound').is('read_by_team_at', null)),
    cnt(db.from('system_alerts').select('id', { count: 'exact', head: true }).is('resolved_at', null).eq('severity', 'error').gte('last_seen_at', new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString())),
    cnt(db.from('system_alerts').select('id', { count: 'exact', head: true }).is('resolved_at', null).eq('source', 'anthropic-api')),
  ]);

  // ── Compose: warnings first, then the day in one line ───────────────
  const warn: string[] = [];
  if (aiDown > 0) warn.push('AI BRAIN DOWN (credits?)');
  if (balance !== null && balance < TWILIO_LOW_BALANCE) warn.push(`Twilio low $${balance.toFixed(2)}`);
  if (alarms > (aiDown > 0 ? 1 : 0)) warn.push(`${alarms} open alarm${alarms === 1 ? '' : 's'}`);

  const day = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric', timeZone: 'America/New_York' });
  const stats = `${newDeals} new leads, ${review} in review, ${queued} texts awaiting your tap, ${outTexts} sent/${inTexts} replies (24h)${unread ? `, ${unread} unread` : ''}`;
  const bal = balance !== null ? `Twilio $${balance.toFixed(2)}` : 'Twilio balance unknown';
  const body = (warn.length ? 'DCC ALERT: ' + warn.join(' + ') + '. ' : 'DCC pulse ') + `${day}: ${stats}. ${bal}.`;

  // ── Send to Nathan via Twilio directly ──────────────────────────────
  // (send-sms EF sits behind JWT auth for browser callers; the project's
  // new-format service keys are not JWTs, so an internal ops ping goes
  // straight to Twilio and logs its own messages_outbound row for parity.)
  let sendOk = false, sendErr: string | null = null;
  try {
    const sid = Deno.env.get('TWILIO_ACCOUNT_SID')!;
    const tok = Deno.env.get('TWILIO_AUTH_TOKEN')!;
    const from = Deno.env.get('TWILIO_FROM_NUMBER')!;
    const form = new URLSearchParams({ To: to, From: from, Body: body.slice(0, 440) });
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + btoa(`${sid}:${tok}`), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    const j = await r.json().catch(() => ({}));
    sendOk = r.ok && !!j.sid;
    if (!sendOk) sendErr = j.message || `Twilio HTTP ${r.status}`;
    await db.from('messages_outbound').insert({
      direction: 'outbound', to_number: to, from_number: from,
      body: body.slice(0, 440), twilio_sid: j.sid || null,
      status: sendOk ? 'queued' : 'failed', error_message: sendErr,
      deal_id: null, channel: 'sms',
    }).then(() => {}, () => {});
  } catch (e) { sendErr = String(e); }

  // ── Email fallback (and belt): the pulse must land SOMEWHERE ────────
  // Discovered on first live fire: Nathan's cell had STOPped the 5440
  // line at some point, so Twilio blocklists it (error 21610) until he
  // texts START. Email rides regardless.
  let emailOk = false;
  try {
    const resendKey = Deno.env.get('RESEND_API_KEY');
    if (resendKey) {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'FundLocators <hello@fundlocators.com>',
          to: ['nathan@fundlocators.com'],
          subject: (warn.length ? '⚠ DCC pulse: ' + warn.join(' + ') : 'DCC pulse: all quiet'),
          text: body + (sendOk ? '' : `\n\n(SMS leg failed: ${sendErr || 'unknown'} - if it says unsubscribed, text START from your cell to (513) 998-5440 to unblock.)`),
        }),
      });
      emailOk = r.ok;
    }
  } catch (_) { /* email is best-effort */ }

  await db.from('sync_watermarks').upsert({
    key: 'morning_pulse', value: new Date().toISOString(),
    detail: { body, sendOk, sendErr, emailOk, balance, newDeals, review, queued, outTexts, inTexts, alarms },
  });

  return json({ ok: sendOk || emailOk, sms: sendOk, email: emailOk, body, balance, error: sendErr });
});

function json(b: unknown, status = 200) {
  return new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
}
