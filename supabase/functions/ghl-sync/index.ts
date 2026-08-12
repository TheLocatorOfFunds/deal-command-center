// ghl-sync — the no-contact brain's bidirectional DND sync (CEO directive
// invariant 1, built 2026-08-12).
//
// ONE truth for "may we contact this person" lives in Supabase
// (may_contact RPC). GHL enforces its own sends via native DND flags,
// so this worker keeps the two aligned in BOTH directions:
//
//   IN : full paginated scan of GHL contacts → upsert ghl_dnd_mirror
//        (id, bare-10 phone, dnd). Any GHL dnd=true whose number matches
//        a DCC contact NOT yet flagged → set do_not_call + do_not_text
//        on the DCC contact + activity log. (A STOP captured in GHL
//        suppresses the machine plane within one sync cycle.)
//   OUT: any DCC contact with do_not_call/do_not_text whose number exists
//        in GHL with dnd=false → PUT GHL dnd=true. (A STOP captured by
//        the DCC/Twilio plane suppresses GHL sends within one cycle.)
//
// Full-scan by design (~1.5k contacts ≈ 15 requests) — no missed-webhook
// risk, no watermark drift; the webhook upgrade can come later without
// changing the contract. Never writes any GHL field except `dnd` — the
// Automations kill-switch field and all case fields are off-limits here.
//
// Auth: POST with X-Ghl-Sync-Secret matching env GHL_SYNC_SECRET
// (pg_cron wrapper reads it from Vault, same pattern as payroll/sweep).
// Env: GHL_PRIVATE_TOKEN, GHL_LOCATION_ID, GHL_SYNC_SECRET + auto-injected
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const GHL_BASE = 'https://services.leadconnectorhq.com';

const bare10 = (p: unknown): string => {
  const d = String(p ?? '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : '';
};

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });
  const secret = Deno.env.get('GHL_SYNC_SECRET') || '';
  if (!secret || req.headers.get('X-Ghl-Sync-Secret') !== secret) {
    return new Response('unauthorized', { status: 401 });
  }

  const tok = Deno.env.get('GHL_PRIVATE_TOKEN')!;
  const loc = Deno.env.get('GHL_LOCATION_ID')!;
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const ghlHeaders = { Authorization: `Bearer ${tok}`, Version: '2021-07-28', Accept: 'application/json' };

  const errors: string[] = [];

  // ── IN: scan GHL contacts → mirror ────────────────────────────────────
  type GC = { id: string; phone?: string; dnd?: boolean; dateUpdated?: string };
  const ghlContacts: GC[] = [];
  let startAfterId = '', startAfter = '', pages = 0;
  while (pages < 60) {
    const q = new URLSearchParams({ locationId: loc, limit: '100' });
    if (startAfterId) { q.set('startAfterId', startAfterId); q.set('startAfter', startAfter); }
    const r = await fetch(`${GHL_BASE}/contacts/?${q}`, { headers: ghlHeaders });
    if (!r.ok) { errors.push(`GHL list page ${pages}: HTTP ${r.status}`); break; }
    const d = await r.json();
    const batch: GC[] = d.contacts || [];
    ghlContacts.push(...batch);
    pages++;
    const meta = d.meta || {};
    if (batch.length < 100 || !meta.startAfterId) break;
    startAfterId = meta.startAfterId; startAfter = String(meta.startAfter ?? '');
  }

  const mirrorRows = ghlContacts.map(c => ({
    ghl_contact_id: c.id,
    phone_bare10: bare10(c.phone) || null,
    dnd: !!c.dnd,
    ghl_updated_at: c.dateUpdated || null,
    synced_at: new Date().toISOString(),
  }));
  for (let i = 0; i < mirrorRows.length; i += 500) {
    const { error } = await db.from('ghl_dnd_mirror').upsert(mirrorRows.slice(i, i + 500));
    if (error) errors.push(`mirror upsert: ${error.message}`);
  }

  // GHL dnd=true numbers → flag matching unflagged DCC contacts
  const ghlDndNums = new Set(mirrorRows.filter(r => r.dnd && r.phone_bare10).map(r => r.phone_bare10 as string));
  let dccFlagged = 0;
  if (ghlDndNums.size) {
    const { data: dccContacts, error } = await db.from('contacts')
      .select('id, name, phone, do_not_call, do_not_text')
      .or('do_not_call.eq.false,do_not_text.eq.false');
    if (error) errors.push(`contacts read: ${error.message}`);
    for (const c of dccContacts || []) {
      const nums = String(c.phone || '').split(',').map(bare10).filter(Boolean);
      if (!nums.some(n => ghlDndNums.has(n))) continue;
      const { error: upErr } = await db.from('contacts')
        .update({ do_not_call: true, do_not_text: true }).eq('id', c.id);
      if (upErr) { errors.push(`flag ${c.id}: ${upErr.message}`); continue; }
      dccFlagged++;
      await db.from('activity').insert({
        deal_id: null, user_id: null,
        action: `🚫 DNC synced from GHL — ${c.name || c.id} marked do-not-call/do-not-text (GHL DND is on for their number)`,
        visibility: ['team'],
      }).then(() => {}, () => {});
    }
  }

  // ── OUT: DCC DNC → GHL DND ────────────────────────────────────────────
  const { data: dccDnc, error: dncErr } = await db.from('contacts')
    .select('id, phone').or('do_not_call.eq.true,do_not_text.eq.true');
  if (dncErr) errors.push(`dcc dnc read: ${dncErr.message}`);
  const dccDncNums = new Set<string>();
  for (const c of dccDnc || []) {
    String(c.phone || '').split(',').map(bare10).filter(Boolean).forEach(n => dccDncNums.add(n));
  }
  let ghlProtected = 0;
  const needProtect = mirrorRows.filter(r => !r.dnd && r.phone_bare10 && dccDncNums.has(r.phone_bare10));
  for (const r of needProtect) {
    const resp = await fetch(`${GHL_BASE}/contacts/${r.ghl_contact_id}`, {
      method: 'PUT',
      headers: { ...ghlHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ dnd: true }),
    });
    if (resp.ok) {
      ghlProtected++;
      await db.from('ghl_dnd_mirror').update({ dnd: true, synced_at: new Date().toISOString() })
        .eq('ghl_contact_id', r.ghl_contact_id);
    } else {
      errors.push(`GHL DND put ${r.ghl_contact_id}: HTTP ${resp.status}`);
    }
  }

  await db.from('sync_watermarks').upsert({
    key: 'ghl_dnd_sync', value: new Date().toISOString(),
    detail: { ghl_contacts: ghlContacts.length, mirror_dnd: ghlDndNums.size, dcc_flagged: dccFlagged, ghl_protected: ghlProtected, errors: errors.length },
  });

  return new Response(JSON.stringify({
    ok: errors.length === 0,
    ghl_contacts_scanned: ghlContacts.length,
    ghl_dnd_numbers: ghlDndNums.size,
    dcc_contacts_newly_flagged: dccFlagged,
    ghl_contacts_newly_protected: ghlProtected,
    errors,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
});
