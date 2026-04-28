// ohio-intel-to-deal
//
// One-click conversion from an ohio-intel case (read-only intelligence)
// into a DCC deal (curated CRM Nathan can run outreach against).
//
// Direction: ohio-intel calls THIS function. Reverse direction of the
// existing intel-sync EF (which pulls events FROM ohio-intel INTO DCC).
//
// Auth: HMAC-SHA256 of raw body using shared secret OHIO_INTEL_TO_DCC_SECRET.
// Same pattern as docket-webhook so Castle/ohio-intel use one signing
// idiom across all DCC inbound EFs.
//
// Idempotent: if an intel_subscription already exists for the
// (county, case_number) pair, returns the existing deal_id with
// existing=true and does NOT create a duplicate deal.
//
// On success creates:
//   - one row in public.deals (type='surplus', status='new-lead')
//   - one row in public.intel_subscriptions (so intel-sync starts
//     pulling events back to DCC on its next 30-min cycle)
//   - one row in public.activity ("Imported from ohio-intel by Nathan")

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

// ─── Types ────────────────────────────────────────────────────────────

type Payload = {
  intel_case_id: string;            // ohio_intel UUID — the case row's id
  county: string;                   // "Butler", "Hamilton", etc.
  case_number: string;              // "CV 2022 08 1416"
  defendant_primary?: string | null; // "Casey Lee Jennings"
  property_street?: string | null;
  property_city?: string | null;
  property_state?: string | null;
  property_zip?: string | null;
  appraised_value?: number | null;
  opening_bid?: number | null;
  judgment_amount?: number | null;
  surplus_estimate?: number | null;
  grade?: string | null;             // "A" / "B" / "C" / "drop" / null
  foreclosure_type?: string | null;
  sale_at?: string | null;           // ISO timestamp
  sale_date?: string | null;         // ISO date
  sourced_by?: string | null;        // user email if known
};

// ─── HMAC helpers (same impl as docket-webhook) ────────────────────────

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
    ['sign'],
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

// ─── Slug + ID generation ──────────────────────────────────────────────

function lastNameSlug(fullName: string | null | undefined): string {
  if (!fullName) return 'unknown';
  // Strip suffixes ("Aka X", "et al", company suffixes), grab the last
  // alpha token as the surname for the slug.
  const cleaned = fullName
    .replace(/\b(et\s+al|aka|a\.?k\.?a\.?|jr|sr|iii|iv|ii|esq)\b\.?/gi, ' ')
    .replace(/\b(llc|inc|corp|co|trust|estate(?:\s+of)?)\b\.?/gi, ' ')
    .trim();
  const tokens = cleaned.split(/[\s,]+/).filter(Boolean);
  const last = tokens[tokens.length - 1] ?? 'unknown';
  return last.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16) || 'unknown';
}

async function pickFreshDealId(
  db: ReturnType<typeof createClient>,
  base: string,
  intelCaseId: string,
): Promise<string> {
  // Try sf-<base> first; if taken, sf-<base>-2, sf-<base>-3 … sf-<base>-9.
  // After that, fall back to sf-<base>-<6 chars from intel_case_id> for
  // guaranteed uniqueness without sequential probing.
  const candidates: string[] = [`sf-${base}`];
  for (let n = 2; n <= 9; n++) candidates.push(`sf-${base}-${n}`);
  candidates.push(`sf-${base}-${intelCaseId.replace(/-/g, '').slice(0, 6)}`);

  for (const candidate of candidates) {
    const { data, error } = await db
      .from('deals')
      .select('id')
      .eq('id', candidate)
      .maybeSingle();
    if (error) throw new Error(`pickFreshDealId: ${error.message}`);
    if (!data) return candidate;
  }
  // Should never reach here unless cosmic collision.
  return `sf-${base}-${crypto.randomUUID().slice(0, 8)}`;
}

// ─── Handler ───────────────────────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, content-type, apikey, x-ohio-intel-signature',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  // ── Auth ────────────────────────────────────────────────────────────
  const sharedSecret = Deno.env.get('OHIO_INTEL_TO_DCC_SECRET');
  if (!sharedSecret) {
    return json({ error: 'OHIO_INTEL_TO_DCC_SECRET not configured' }, 503);
  }
  const sig = req.headers.get('x-ohio-intel-signature') || '';
  const rawBody = await req.text();
  const expected = await hmacSha256(sharedSecret, rawBody);
  if (!timingSafeEqual(sig, expected)) {
    return json({ error: 'invalid signature' }, 401);
  }

  // ── Parse ───────────────────────────────────────────────────────────
  let payload: Payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }
  for (const k of ['intel_case_id', 'county', 'case_number'] as const) {
    if (!payload[k]) return json({ error: `missing required field: ${k}` }, 400);
  }

  // ── DB ──────────────────────────────────────────────────────────────
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) return json({ error: 'DCC supabase env missing' }, 500);
  const db = createClient(supabaseUrl, serviceKey);

  // ── Idempotency check — already imported? ───────────────────────────
  const normalizedCounty = payload.county.trim();
  const normalizedCase = payload.case_number.trim();
  const { data: existing, error: existingErr } = await db
    .from('intel_subscriptions')
    .select('deal_id, status, last_synced_at')
    .eq('county', normalizedCounty)
    .eq('case_number', normalizedCase)
    .maybeSingle();
  if (existingErr) return json({ error: `intel_subscriptions lookup: ${existingErr.message}` }, 500);

  if (existing) {
    return json({
      ok: true,
      existing: true,
      deal_id: existing.deal_id,
      message: `Already imported as ${existing.deal_id} (status: ${existing.status})`,
      url: `https://app.refundlocators.com/?deal=${encodeURIComponent(existing.deal_id)}`,
    });
  }

  // ── Generate deal_id + insert deal ──────────────────────────────────
  const slug = lastNameSlug(payload.defendant_primary);
  let newDealId: string;
  try {
    newDealId = await pickFreshDealId(db, slug, payload.intel_case_id);
  } catch (e) {
    return json({ error: `deal_id generation: ${(e as Error).message}` }, 500);
  }

  const propertyAddress = [
    payload.property_street,
    payload.property_city,
    payload.property_state,
    payload.property_zip,
  ]
    .filter(Boolean)
    .join(', ');

  const dealName =
    payload.defendant_primary?.trim() ||
    `${normalizedCounty} · ${normalizedCase}`;

  const meta: Record<string, unknown> = {
    sourced_from: 'ohio-intel',
    sourced_at: new Date().toISOString(),
    sourced_by: payload.sourced_by ?? null,
    intel_case_id: payload.intel_case_id,
    county: normalizedCounty,
    case_number: normalizedCase,
    grade: payload.grade ?? null,
    foreclosure_type: payload.foreclosure_type ?? null,
    appraised_value: payload.appraised_value ?? null,
    opening_bid: payload.opening_bid ?? null,
    judgment_amount: payload.judgment_amount ?? null,
    estimated_surplus: payload.surplus_estimate ?? null,
    sale_at: payload.sale_at ?? null,
    sale_date: payload.sale_date ?? null,
  };

  const { error: dealErr } = await db.from('deals').insert({
    id: newDealId,
    type: 'surplus',
    status: 'new-lead',
    name: dealName,
    address: propertyAddress || null,
    meta,
  });
  if (dealErr) return json({ error: `deal insert: ${dealErr.message}` }, 500);

  // ── Insert intel_subscription so intel-sync picks it up ─────────────
  const { error: subErr } = await db.from('intel_subscriptions').insert({
    deal_id: newDealId,
    case_number: normalizedCase,
    county: normalizedCounty,
    case_type: 'foreclosure',
    intel_case_id: payload.intel_case_id,
    status: 'matched', // already matched at creation — we know the intel row exists
  });
  if (subErr) {
    // Rollback the deal insert so we don't leave an orphan.
    await db.from('deals').delete().eq('id', newDealId);
    return json({ error: `intel_subscriptions insert: ${subErr.message}` }, 500);
  }

  // ── Activity row (Nathan sees this in the deal's activity feed) ─────
  await db.from('activity').insert({
    deal_id: newDealId,
    action: payload.sourced_by
      ? `Imported from ohio-intel by ${payload.sourced_by}`
      : 'Imported from ohio-intel',
  });

  return json({
    ok: true,
    existing: false,
    deal_id: newDealId,
    message: `Created ${newDealId}`,
    url: `https://app.refundlocators.com/?deal=${encodeURIComponent(newDealId)}`,
  });
});
