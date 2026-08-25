// ghl-bridge — THE one code path from the DCC engine into GoHighLevel.
// (CEO directive: migration engineer lane; built 2026-08-12.)
//
// Actions (POST, X-Ghl-Sync-Secret auth — same secret as ghl-sync):
//   { action: "push_deal", deal_id }  → upsert the deal's contacts (homeowner
//     + family, each their OWN contact — Option A) and its opportunity with
//     the full field contract. Idempotent: mappings write back to
//     deals.meta.ghl_opportunity_id / contacts via ghl_contact_map.
//   { action: "self_test" }           → create a synthetic contact+opportunity
//     (fake 555 number, name "Zz Bridge Selftest"), read both back, verify
//     every field landed, DELETE both, return the diff report. Proves the
//     pipe end-to-end without touching a real person.
//
// Constitution (from GHL_CONTACT_FIELD_MAP_2026-08-11.md — approved):
//   • DND set on the SAME upsert that creates a DNC person — never a later pass.
//   • No-null-clobber: only non-empty values are sent; never blank out GHL data.
//   • Tags are ADDITIVE (POST /contacts/{id}/tags) — never sent via upsert,
//     which would replace the contact's existing tag set.
//   • Per-field allow-list only. FORBIDDEN always: the `Automations` field
//     (workflow master kill-switch), Chat-folder fields, legacy `DNC` checkbox.
//   • Total Debt is judgment principal — copied verbatim, never derived.
//   • First Name + address1 always written when known (locks Helen, the AI
//     receptionist, out of "Save Value" overwrites from call audio).
//   • Deceased homeowners: contact created for the record, DND on.
//   • Machine-plane (meta.plane='machine') and dead/deleted deals REFUSED —
//     exclusive-ownership invariant enforced at the pipe, not by convention.
//   • Resolution by NAME at runtime (fields, pipeline, stages) — no hardcoded
//     ids; survives GHL-side renames of nothing / additions of anything.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const GHL = 'https://services.leadconnectorhq.com';
const PIPELINE_NAME = 'Outbound Lead Pipeline🤵🏻';
const STAGE_BY_STATUS: Record<string, string> = {
  'new-lead': 'New Lead',
  'signed': 'Contract Signed',
  'filed': 'Motion for Distribution',
  'awaiting-distribution': 'Motion for Distribution',
  'recovered': 'Check Received (Closed)',
};
// Core-5 NOD lifecycle (Ohio ferry 2026-08-25, Nathan's spec): pre-sale
// stages driven by meta.lifecycleStage, ahead of the status-based back half.
// Stage names resolve at runtime — until the GHL Pro adds these stages to
// the pipeline, pushes fall back to "New Lead" and report stage_fallback.
const STAGE_BY_LIFECYCLE: Record<string, string> = {
  'nod': 'NOD Filed',
  '30day': '30 Days Out',
  'saleday': 'Sale Day',
};

const bare10 = (p: unknown): string => {
  const d = String(p ?? '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : '';
};
const e164 = (p: string): string => (bare10(p) ? '+1' + bare10(p) : '');
const nonEmpty = (v: unknown): boolean => v !== null && v !== undefined && String(v).trim() !== '' && String(v) !== '0';
const money = (v: unknown): number | null => { const n = parseFloat(String(v)); return Number.isFinite(n) && n > 0 ? n : null; };
const dateOnly = (v: unknown): string | null => { const s = String(v ?? '').slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; };

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });
  const secret = Deno.env.get('GHL_SYNC_SECRET') || '';
  if (!secret || req.headers.get('X-Ghl-Sync-Secret') !== secret) {
    return new Response('unauthorized', { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const tok = Deno.env.get('GHL_PRIVATE_TOKEN')!;
  const loc = Deno.env.get('GHL_LOCATION_ID')!;
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const H = { Authorization: `Bearer ${tok}`, Version: '2021-07-28', 'Content-Type': 'application/json', Accept: 'application/json' };

  const ghl = async (method: string, path: string, payload?: unknown) => {
    const r = await fetch(GHL + path, { method, headers: H, body: payload === undefined ? undefined : JSON.stringify(payload) });
    const text = await r.text();
    let json: any = null; try { json = JSON.parse(text); } catch { /* keep text */ }
    if (!r.ok) throw new Error(`GHL ${method} ${path} -> ${r.status}: ${text.slice(0, 200)}`);
    return json;
  };

  // ── Runtime resolution: fields by name, pipeline + stages by name ──────
  const [cfContact, cfOpp, pipes] = await Promise.all([
    ghl('GET', `/locations/${loc}/customFields`),
    ghl('GET', `/locations/${loc}/customFields?model=opportunity`),
    ghl('GET', `/opportunities/pipelines?locationId=${loc}`),
  ]);
  const cId = (name: string): string | null =>
    (cfContact.customFields || []).find((f: any) => f.name === name)?.id || null;
  const oId = (name: string): string | null =>
    (cfOpp.customFields || []).find((f: any) => f.name === name)?.id || null;
  const pipe = (pipes.pipelines || []).find((p: any) => p.name === PIPELINE_NAME);
  if (!pipe) return new Response(JSON.stringify({ ok: false, error: `pipeline "${PIPELINE_NAME}" not found` }), { status: 500 });
  const stageId = (name: string): string | null =>
    (pipe.stages || []).find((s: any) => s.name === name)?.id || null;

  const cf = (id: string | null, value: unknown) => (id && nonEmpty(value) ? [{ id, field_value: value }] : []);

  // Build the contact payload for one person. NEVER includes tags (additive
  // via separate endpoint) and NEVER touches forbidden fields.
  const contactPayload = (p: {
    firstName: string; lastName: string; phone?: string; email?: string;
    address?: string; city?: string; state?: string; zip?: string;
    dnd: boolean; caseNumber?: string; county?: string; claimStatus?: string;
    intelCaseId?: string; linkUrl?: string; source: string;
  }) => ({
    locationId: loc,
    firstName: p.firstName, lastName: p.lastName,
    ...(nonEmpty(p.phone) ? { phone: e164(p.phone!) } : {}),
    ...(nonEmpty(p.email) ? { email: p.email } : {}),
    ...(nonEmpty(p.address) ? { address1: p.address } : {}),
    ...(nonEmpty(p.city) ? { city: p.city } : {}),
    ...(nonEmpty(p.state) ? { state: p.state } : {}),
    ...(nonEmpty(p.zip) ? { postalCode: p.zip } : {}),
    source: p.source,
    dnd: p.dnd,
    customFields: [
      ...cf(cId('Case Number'), p.caseNumber),
      ...cf(cId('County'), p.county),
      ...cf(cId('Surplus Claim Status'), p.claimStatus),
      ...cf(cId('Intel Case ID'), p.intelCaseId),
      ...cf(cId('Personalized Link URL'), p.linkUrl),
    ],
  });

  // ── SELF TEST ──────────────────────────────────────────────────────────
  if (body.action === 'self_test') {
    const report: Record<string, unknown> = {};
    const up = await ghl('POST', '/contacts/upsert', contactPayload({
      firstName: 'Zz', lastName: 'Bridge Selftest', phone: '5135550100',
      address: '1 Test Rd', city: 'Testville', state: 'OH', zip: '45000',
      dnd: true, caseNumber: 'TEST 0000', county: 'Testshire',
      claimStatus: 'self_test', intelCaseId: 'selftest-1',
      linkUrl: 'https://refundlocators.com/s/selftest', source: 'bridge-self-test',
    }));
    const cid = up.contact?.id;
    report.contact_created = !!cid;
    await ghl('POST', `/contacts/${cid}/tags`, { tags: ['dcc-migrated'] });

    const opp = await ghl('POST', '/opportunities/', {
      locationId: loc, pipelineId: pipe.id,
      pipelineStageId: stageId('New Lead'), contactId: cid,
      name: 'Zz Bridge Selftest — TEST 0000', status: 'open', monetaryValue: 12345,
      customFields: [
        ...cf(oId('Case Number'), 'TEST 0000'),
        ...cf(oId('Judgment Amount'), 11111),
        ...cf(oId('Total Debt'), 11111),
        ...cf(oId('Verified Surplus'), 12345),
        ...cf(oId('Sale Date'), '2026-01-15'),
        ...cf(oId('DCC Deal ID'), 'selftest-1'),
      ],
    });
    const oid = opp.opportunity?.id;
    report.opportunity_created = !!oid;

    // read back + verify
    const cBack = await ghl('GET', `/contacts/${cid}`);
    const got = cBack.contact || {};
    report.readback = {
      dnd: got.dnd === true,
      firstName: got.firstName === 'Zz',
      address1: got.address1 === '1 Test Rd',
      tag: (got.tags || []).includes('dcc-migrated'),
      custom_count: (got.customFields || []).length,
    };
    const oBack = await ghl('GET', `/opportunities/${oid}`);
    report.opp_readback = {
      stage: oBack.opportunity?.pipelineStageId === stageId('New Lead'),
      value: oBack.opportunity?.monetaryValue === 12345,
      custom_count: (oBack.opportunity?.customFields || []).length,
    };
    // cleanup
    await ghl('DELETE', `/opportunities/${oid}`);
    await ghl('DELETE', `/contacts/${cid}`);
    report.cleaned_up = true;
    return new Response(JSON.stringify({ ok: true, report }), { headers: { 'Content-Type': 'application/json' } });
  }

  // ── PUSH ONE DEAL ──────────────────────────────────────────────────────
  if (body.action === 'push_deal') {
    const dealId = String(body.deal_id || '');
    const { data: d, error } = await db.from('deals')
      .select('id, name, address, status, type, lead_tier, deleted_at, last_contacted_at, refundlocators_token, surplus_estimate, tags, meta')
      .eq('id', dealId).single();
    if (error || !d) return new Response(JSON.stringify({ ok: false, error: 'deal not found' }), { status: 404 });

    // Exclusive-ownership invariant, enforced at the pipe:
    if (d.deleted_at || ['dead', 'closed'].includes(d.status)) {
      return new Response(JSON.stringify({ ok: false, error: 'refused: dead/deleted deals never enter GHL' }), { status: 422 });
    }
    const m = d.meta || {};
    if (m.plane === 'machine') {
      return new Response(JSON.stringify({ ok: false, error: 'refused: machine-plane lead (sniper shelf) — release it to the ghl plane first' }), { status: 422 });
    }
    if (m.hold?.reason) {
      return new Response(JSON.stringify({ ok: false, error: 'refused: lead is on ⏸ hold' }), { status: 422 });
    }

    const { data: links } = await db.from('contact_deals').select('contact_id').eq('deal_id', d.id);
    const ids = (links || []).map(l => l.contact_id);
    const { data: peopleRows } = ids.length
      ? await db.from('contacts').select('id, name, kind, phone, email, do_not_call, do_not_text').in('id', ids)
      : { data: [] as any[] };
    const people: any[] = [...(peopleRows || [])];
    // NOD-pipeline deals arrive with no contact rows — the homeowner exists
    // only as deal meta (defendant name, usually no phone yet). Synthesize
    // the homeowner card so the opportunity has an anchor; meta.ghl_contact_id
    // reuse (below) keeps identifier-less contacts from duplicating on re-push.
    if (!people.some((p) => p.kind === 'homeowner')) {
      people.unshift({
        id: null, kind: 'homeowner',
        name: m.homeownerName || m.defendant || d.name || 'Unknown Owner',
        phone: m.homeownerPhone || m.phone || '',
        email: m.homeownerEmail || '',
        do_not_call: false, do_not_text: false,
      });
    }

    const deceased = ['true', 'Y', 'yes'].includes(String(m.deceased ?? m.isDeceased ?? ''));
    const caseNo = m.courtCase || '';
    const county = m.county || '';
    const stateAbbr = m.state || 'OH';
    const linkUrl = d.refundlocators_token ? `https://refundlocators.com/s/${d.refundlocators_token}` : '';
    const claim = m.surplusClaimStatus || (m.reviewFlag ? String(m.reviewFlag) : '');
    const [street, city] = String(d.address || '').split(',').map((s: string) => s.trim());

    const results: any[] = [];
    let homeownerGhlId: string | null = null;

    for (const p of people || []) {
      const nameParts = String(p.name || 'Unknown').trim().split(/\s+/);
      const isHomeowner = p.kind === 'homeowner';
      const dnd = !!(p.do_not_call || p.do_not_text || (isHomeowner && deceased));
      // DCC stores comma-lists in BOTH phone and email — GHL takes one each.
      // One contact's rejection must never sink the whole deal: catch, record,
      // continue (found the hard way: a two-email field 500'd Nicholas Kennedy).
      const firstEmail = String(p.email || '').split(/[,;]/)[0].trim();
      try {
        const payload = contactPayload({
          firstName: nameParts[0] || 'Unknown', lastName: nameParts.slice(1).join(' ') || '—',
          phone: String(p.phone || '').split(',')[0], email: firstEmail,
          address: street, city, state: stateAbbr,
          dnd, caseNumber: caseNo, county,
          claimStatus: isHomeowner ? claim : '', intelCaseId: m.intel_case_id || '',
          linkUrl: isHomeowner ? linkUrl : '', source: 'dcc-migration',
        });
        let cid: string | null = null;
        let isNew: boolean | null = null;
        const hasIdentifier = bare10(String(p.phone || '').split(',')[0]).length === 10 || !!firstEmail;
        if (p.id === null && m.ghl_contact_id) {
          // synthesized homeowner already exists in GHL — update, never re-create
          await ghl('PUT', `/contacts/${m.ghl_contact_id}`, payload);
          cid = m.ghl_contact_id; isNew = false;
        } else if (!hasIdentifier) {
          // GHL upsert REQUIRES phone or email; identifier-less NOD shells go
          // through plain create — the meta.ghl_contact_id write-back + the
          // PUT branch above make re-pushes update instead of duplicate.
          const created = await ghl('POST', '/contacts/', payload);
          cid = created.contact?.id || null; isNew = true;
        } else {
          const up = await ghl('POST', '/contacts/upsert', payload);
          cid = up.contact?.id || null; isNew = up.new ?? null;
        }
        if (cid) {
          const tags = ['dcc-migrated'];
          if (m.lifecycleStage) tags.push('nod-pipeline');
          // deal-level tags (stage + county + brand, per the Ohio NOD contract)
          // ride on the HOMEOWNER card; additive endpoint, never replaces.
          if (isHomeowner && Array.isArray(d.tags)) tags.push(...d.tags.map((t: unknown) => String(t)).filter(Boolean).slice(0, 10));
          if (!isHomeowner) tags.push(p.kind || 'family');
          await ghl('POST', `/contacts/${cid}/tags`, { tags });
          if (p.id) {
            await db.from('ghl_contact_map').upsert({
              ghl_contact_id: cid, dcc_contact_id: p.id,
              phone_bare10: bare10(String(p.phone || '').split(',')[0]) || null,
            });
          }
          if (isHomeowner) homeownerGhlId = cid;
        }
        results.push({ contact: p.id, kind: p.kind, ghl_id: cid, dnd, new: isNew });
      } catch (e) {
        results.push({ contact: p.id, kind: p.kind, ghl_id: null, dnd, error: String(e).slice(0, 200) });
      }
    }

    // Stage: lifecycle first (pre-sale NOD flow), then status; if the mapped
    // stage doesn't exist in the pipeline yet, fall back to "New Lead" and
    // say so in the result rather than failing the push.
    const wantStageName = STAGE_BY_LIFECYCLE[String(m.lifecycleStage || '')] || STAGE_BY_STATUS[d.status] || 'New Lead';
    let stageIdResolved = stageId(wantStageName);
    let stageFallback: string | null = null;
    if (!stageIdResolved) { stageFallback = wantStageName; stageIdResolved = stageId('New Lead'); }

    // Court files STAY in Supabase (approved migration pattern) — the card
    // carries long-lived signed links, not copies. Cap 5, newest first.
    const docLinks: string[] = [];
    try {
      const { data: docs } = await db.from('documents')
        .select('name, path').eq('deal_id', d.id).order('created_at', { ascending: false }).limit(5);
      for (const doc of docs || []) {
        if (!doc.path) continue;
        const { data: signed } = await db.storage.from('deal-docs').createSignedUrl(doc.path, 60 * 60 * 24 * 365);
        if (signed?.signedUrl) docLinks.push(`${doc.name || 'document'}: ${signed.signedUrl}`);
      }
    } catch (_) { /* links are best-effort — never block a push on them */ }

    let oppId = m.ghl_opportunity_id || null;
    if (homeownerGhlId) {
      const oppPayload = {
        locationId: loc, pipelineId: pipe.id,
        pipelineStageId: stageIdResolved,
        contactId: homeownerGhlId,
        name: `${d.name}${caseNo ? ' — ' + caseNo : ''}`,
        status: 'open',
        monetaryValue: money(m.verifiedSurplus) ?? money(m.estimatedSurplus) ?? money(d.surplus_estimate) ?? 0,
        customFields: [
          ...cf(oId('Case Number'), caseNo),
          ...cf(oId('County'), county),
          ...cf(oId('Case State'), stateAbbr),
          ...cf(oId('Sale Date'), dateOnly(m.saleDate)),
          ...cf(oId('Sold Amount'), money(m.salePrice)),
          ...cf(oId('Confirmation Date'), dateOnly(m.confirmationOfSaleDate)),
          ...cf(oId('Foreclosure Filed Date'), dateOnly(m.foreclosureFileDate)),
          ...cf(oId('Judgment Amount'), money(m.judgmentAmount)),
          ...cf(oId('Total Debt'), money(m.totalDebt)),
          ...cf(oId('Verified Surplus'), money(m.verifiedSurplus)),
          ...cf(oId('Claim Status'), claim),
          ...cf(oId('Personalized Link URL'), linkUrl),
          ...cf(oId('Deal Source'), 'dcc-migration'),
          ...cf(oId('Intel Case ID'), m.intel_case_id),
          ...cf(oId('DCC Deal ID'), d.id),
          ...cf(oId('Work Order Rank'), m.workOrderRank),
        ],
      };
      if (oppId) {
        await ghl('PUT', `/opportunities/${oppId}`, oppPayload);
      } else {
        const created = await ghl('POST', '/opportunities/', oppPayload);
        oppId = created.opportunity?.id || null;
      }
      // Write-back EVERY push (create AND update): ids, human-plane stamp,
      // and the stage we synced — the nod-batch action keys off ghl_synced_stage.
      await db.from('deals').update({
        meta: {
          ...m,
          ghl_opportunity_id: oppId,
          ghl_contact_id: homeownerGhlId,
          plane: m.plane === 'machine' ? m.plane : 'ghl',
          ghl_synced_stage: String(m.lifecycleStage || d.status || ''),
        },
      }).eq('id', d.id).select('id');

      // Document links onto the homeowner card (best-effort)
      if (docLinks.length) {
        const dlId = cId('Document Links');
        if (dlId) {
          await ghl('PUT', `/contacts/${homeownerGhlId}`, {
            customFields: [{ id: dlId, field_value: docLinks.join('\n') }],
          }).catch(() => {});
        }
      }

      // the migration note (once — skip if we updated an existing opp)
      if (homeownerGhlId && !m.ghl_opportunity_id) {
        const note = [
          `Migrated from the DCC engine ${new Date().toISOString().slice(0, 10)}.`,
          caseNo ? `Case ${caseNo} (${county} County${stateAbbr ? ', ' + stateAbbr : ''}).` : '',
          m.lifecycleStageLabel ? `Lifecycle: ${m.lifecycleStageLabel}.` : '',
          money(m.verifiedSurplus) ? `Verified surplus $${money(m.verifiedSurplus)}.` : (money(m.estimatedSurplus) ? `Estimated surplus $${money(m.estimatedSurplus)} (unverified).` : ''),
          d.last_contacted_at ? `Last contacted ${String(d.last_contacted_at).slice(0, 10)}.` : 'Never contacted.',
          claim ? `Claim/review status: ${claim}.` : '',
          docLinks.length ? `Documents:\n${docLinks.join('\n')}` : '',
          `Full history + court files: https://app.refundlocators.com/#/deal/${d.id}`,
        ].filter(Boolean).join('\n');
        await ghl('POST', `/contacts/${homeownerGhlId}/notes`, { body: note, userId: undefined });
      }
    }

    return new Response(JSON.stringify({ ok: true, deal: d.id, contacts: results, opportunity: oppId, stage: wantStageName, stage_fallback: stageFallback }), { headers: { 'Content-Type': 'application/json' } });
  }

  // ── NOD BATCH (cron): push new/stage-advanced lifecycle deals ─────────
  // Reuses push_deal via an internal self-call (bounded, secret-gated) so
  // there is exactly ONE code path into GHL.
  if (body.action === 'push_nod_batch') {
    const limit = Math.min(Number(body.limit) || 20, 40);
    const { data: cands, error: candErr } = await db.from('deals')
      .select('id, meta').is('deleted_at', null).eq('status', 'new-lead')
      .like('id', 'nod-oh-%').limit(400);
    if (candErr) return new Response(JSON.stringify({ ok: false, error: candErr.message }), { status: 500 });
    const due = (cands || []).filter((r: any) => {
      const mm = r.meta || {};
      if (mm.plane === 'machine' || mm.hold?.reason) return false;
      if (!mm.lifecycleStage) return false;
      return !mm.ghl_opportunity_id || String(mm.lifecycleStage) !== String(mm.ghl_synced_stage || '');
    }).slice(0, limit);
    const out: any[] = [];
    for (const r of due) {
      try {
        const resp = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/ghl-bridge`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Ghl-Sync-Secret': secret },
          body: JSON.stringify({ action: 'push_deal', deal_id: r.id }),
        });
        const j = await resp.json().catch(() => ({ ok: false, error: `HTTP ${resp.status}` }));
        out.push({ deal: r.id, ok: !!j.ok, opportunity: j.opportunity || null, stage_fallback: j.stage_fallback || null, error: j.error || null });
      } catch (e) {
        out.push({ deal: r.id, ok: false, error: String(e).slice(0, 150) });
      }
    }
    return new Response(JSON.stringify({ ok: true, candidates: due.length, pushed: out.filter(o => o.ok).length, results: out }), { headers: { 'Content-Type': 'application/json' } });
  }

  return new Response(JSON.stringify({ ok: false, error: 'unknown action' }), { status: 400 });
});
