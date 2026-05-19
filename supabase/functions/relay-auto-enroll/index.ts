import { createClient } from 'jsr:@supabase/supabase-js@2'

/**
 * relay-auto-enroll -- Scans deals and enrolls eligible ones into FL Relay sequences.
 *
 * Called by pg_cron every 15 minutes. Handles two sequences:
 *
 *   ohio-preauction-v1:
 *     Trigger: deal.is_30dts = true (auction within 30 days)
 *     Eligibility: lead_tier IN ('A','B'), death_signal=false, phone present,
 *                  not already enrolled, not deleted, not in a terminal status
 *
 *   ohio-surplus-v1:
 *     Trigger: deal.days_to_sale < 0 OR (days_to_sale IS NULL AND meta.saleDate is in the past)
 *     Eligibility: lead_tier IN ('A','B'), death_signal=false,
 *                  phone present, not already enrolled, not deleted,
 *                  not in a terminal status, no prior sent outreach (old cadence)
 *
 * Terminal statuses excluded from both sequences:
 *   signed, filed, probate, awaiting-distribution, recovered,
 *   under-contract, closed, listing, claim-filed
 *
 * Note on the Ohio Intel grading agent: the agent-side grade (A/B/C/drop)
 * in meta.grade is not yet populated because the BatchData valuation pipeline
 * (Phase 6) is still blocked. Until that pipeline is live, we use DCC's own
 * lead_tier field as the eligibility gate. Once meta.grade is populated, we
 * can layer that in as an additional filter here.
 *
 * Contact data mapping from deals:
 *   first_name         <- first word of meta.homeownerName
 *   last_name          <- rest of meta.homeownerName
 *   county             <- meta.county (stripped of " County" suffix)
 *   street_address     <- deals.address (street portion only, before first comma)
 *   case_number        <- meta.courtCase
 *   auction_date       <- meta.saleDate formatted as "Month D, YYYY"
 *   days_until_auction <- deals.days_to_sale
 *   case_month         <- month name from meta.saleDate (for surplus sequence)
 *   case_year          <- year from meta.saleDate
 *   agent_first_name   <- 'Nathan' (default)
 *
 * Phone fallback: if meta.homeownerPhone is absent, the most recent
 * outreach_queue row for that deal is checked for contact_phone.
 *
 * Auth: RELAY_SECRET header.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-relay-secret',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

// Parse "2026-06-04" -> { month: 'June', year: '2026', formatted: 'June 4, 2026' }
function parseSaleDate(dateStr: string | null): { month: string; year: string; formatted: string } | null {
  if (!dateStr) return null
  const parts = dateStr.split('-')
  if (parts.length < 3) return null
  const year = parts[0]
  const monthIdx = parseInt(parts[1], 10) - 1
  const day = parseInt(parts[2], 10)
  if (isNaN(monthIdx) || monthIdx < 0 || monthIdx > 11) return null
  const month = MONTH_NAMES[monthIdx]
  return { month, year, formatted: `${month} ${day}, ${year}` }
}

// Split "Kim Rock" -> { first: 'Kim', last: 'Rock' }
// "John Paul Jones" -> { first: 'John', last: 'Paul Jones' }
// "Kemper" -> { first: 'Kemper', last: '' }
function splitName(fullName: string | null): { first: string; last: string } {
  if (!fullName || !fullName.trim()) return { first: '', last: '' }
  const parts = fullName.trim().split(/\s+/)
  const first = parts[0]
  const last = parts.slice(1).join(' ')
  return { first, last }
}

// Strip street address from full address: "123 Main St, Columbus, OH 43215" -> "123 Main St"
function streetOnly(address: string | null): string {
  if (!address) return ''
  return address.split(',')[0].trim()
}

// Clean county: "Butler County" -> "Butler", "Franklin" -> "Franklin"
function cleanCounty(county: string | null): string {
  if (!county) return ''
  return county.replace(/\s+county$/i, '').trim()
}

// Normalize phone to E.164
function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return `+${digits}`
}

// Returns true if saleDate string (YYYY-MM-DD) represents a date strictly before today.
function saleDateIsInPast(dateStr: string | null): boolean {
  if (!dateStr) return false
  const today = new Date()
  const todayStr = today.toISOString().slice(0, 10) // "YYYY-MM-DD"
  return dateStr < todayStr
}

// Statuses that indicate the deal is already in a contracted or closed phase.
// Deals in these statuses should not receive automated relay outreach.
const EXCLUDED_STATUSES = new Set([
  'signed',
  'filed',
  'probate',
  'awaiting-distribution',
  'recovered',
  'under-contract',
  'closed',
  'listing',
  'claim-filed',
])

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

  const supabaseUrl    = Deno.env.get('SUPABASE_URL')!
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const relaySecret    = Deno.env.get('RELAY_SECRET')

  // Auth: accept relay secret header (from pg_cron) OR a Bearer JWT (from the DCC browser client)
  const headerSecret = req.headers.get('x-relay-secret') || ''
  const hasRelaySecret = relaySecret && headerSecret === relaySecret
  const hasBearer = req.headers.get('authorization')?.startsWith('Bearer ')
  if (!hasRelaySecret && !hasBearer) {
    return json({ error: 'unauthorized' }, 401)
  }

  const sb = createClient(supabaseUrl, serviceRoleKey)

  // ── 1. Fetch already-enrolled deal IDs per sequence ──────────────────────
  // Used to skip deals we have already enrolled so we don't call relay-enroll
  // unnecessarily (relay-enroll would return 409, but better to skip upfront).
  const { data: existingEnrollments } = await sb
    .from('relay_enrollments')
    .select('deal_id, sequence_id')
    .in('sequence_id', ['ohio-preauction-v1', 'ohio-surplus-v1'])
    .in('status', ['active', 'paused', 'completed', 'manual_hold'])
    .not('deal_id', 'is', null)

  const enrolledBySeq: Record<string, Set<string>> = {
    'ohio-preauction-v1': new Set(),
    'ohio-surplus-v1':    new Set(),
  }
  for (const e of (existingEnrollments || [])) {
    enrolledBySeq[e.sequence_id]?.add(e.deal_id)
  }

  // ── 2. Fetch deal IDs that already have a SENT outreach (old cadence) ────
  // These are rows in outreach_queue where status='sent' and
  // relay_enrollment_id IS NULL, meaning the old manual/bulk cadence already
  // contacted this person. We skip them for the surplus sequence to avoid
  // double-contacting.
  const { data: priorOutreachRows } = await sb
    .from('outreach_queue')
    .select('deal_id')
    .eq('status', 'sent')
    .is('relay_enrollment_id', null)
    .not('deal_id', 'is', null)

  const priorOutreachDealIds = new Set<string>(
    (priorOutreachRows || []).map((r: { deal_id: string }) => r.deal_id)
  )

  // ── 3. Build a phone fallback map from outreach_queue ────────────────────
  // For deals where meta.homeownerPhone is missing, we look up the most recent
  // outreach_queue row for that deal and use its contact_phone.
  // We fetch all rows that have a contact_phone and are not null for deal_id,
  // then keep only the most recent row per deal_id.
  const { data: outreachPhoneRows } = await sb
    .from('outreach_queue')
    .select('deal_id, contact_phone, created_at')
    .not('deal_id', 'is', null)
    .not('contact_phone', 'is', null)
    .order('created_at', { ascending: false })

  // Build a map: deal_id -> contact_phone (first row = most recent due to ORDER BY desc)
  const fallbackPhoneMap = new Map<string, string>()
  for (const row of (outreachPhoneRows || [])) {
    if (!fallbackPhoneMap.has(row.deal_id) && row.contact_phone?.trim()) {
      fallbackPhoneMap.set(row.deal_id, row.contact_phone.trim())
    }
  }

  const results = {
    preauction_enrolled:  [] as string[],
    preauction_skipped:   [] as string[],
    surplus_enrolled:     [] as string[],
    surplus_skipped:      [] as string[],
    errors:               [] as { deal_id: string; error: string }[],
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 4. PRE-AUCTION TRIGGER
  //    is_30dts = true, lead_tier IN ('A','B'), not deceased, not terminal status
  // ─────────────────────────────────────────────────────────────────────────
  const { data: preAuctionDeals } = await sb
    .from('deals')
    .select('id, name, address, meta, days_to_sale, surplus_estimate, status, lead_tier')
    .in('lead_tier', ['A', 'B'])
    .eq('is_30dts', true)
    .eq('type', 'surplus')
    .is('deleted_at', null)

  for (const deal of (preAuctionDeals || [])) {
    // Skip terminal statuses
    if (EXCLUDED_STATUSES.has(deal.status)) {
      results.preauction_skipped.push(`${deal.id} (excluded status: ${deal.status})`)
      continue
    }

    // Phone: prefer meta, fall back to outreach_queue
    const rawPhone = deal.meta?.homeownerPhone?.trim() || fallbackPhoneMap.get(deal.id) || ''
    if (!rawPhone) {
      results.preauction_skipped.push(`${deal.id} (no phone)`)
      continue
    }

    if (enrolledBySeq['ohio-preauction-v1'].has(deal.id)) {
      results.preauction_skipped.push(`${deal.id} (already enrolled)`)
      continue
    }

    // Name: prefer meta.homeownerName, fall back to deals.name column
    const rawName = deal.meta?.homeownerName?.trim() || (deal as any).name || ''
    const { first, last } = splitName(rawName)
    if (!first) {
      results.preauction_skipped.push(`${deal.id} (no name)`)
      continue
    }

    const saleDate = parseSaleDate(deal.meta?.saleDate)
    const county   = cleanCounty(deal.meta?.county)
    const street   = streetOnly(deal.address)
    const caseNum  = deal.meta?.courtCase || ''

    const contactData: Record<string, string | number> = {
      first_name:         first,
      last_name:          last,
      county:             county || 'your',
      street_address:     street || deal.address || '',
      case_number:        caseNum,
      auction_date:       saleDate?.formatted || deal.meta?.saleDate || '',
      days_until_auction: deal.days_to_sale ?? 0,
      agent_first_name:   'Nathan',
    }

    const enrollResp = await callRelayEnroll(supabaseUrl, serviceRoleKey, relaySecret, {
      sequence_id:   'ohio-preauction-v1',
      contact_phone: normalizePhone(rawPhone),
      deal_id:       deal.id,
      contact_data:  contactData,
    })

    if (enrollResp.ok) {
      results.preauction_enrolled.push(deal.id)
      console.log(`relay-auto-enroll: enrolled ${deal.id} into ohio-preauction-v1`)
    } else if (enrollResp.status === 409) {
      results.preauction_skipped.push(`${deal.id} (already enrolled - race)`)
    } else {
      const err = `HTTP ${enrollResp.status}: ${enrollResp.error}`
      results.errors.push({ deal_id: deal.id, error: err })
      console.error(`relay-auto-enroll: failed ${deal.id} preauction: ${err}`)
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 5. POST-AUCTION / SURPLUS TRIGGER
  //    Eligibility: lead_tier IN ('A','B'), not deceased, not terminal status,
  //    no prior sent outreach from the old cadence.
  //    Trigger (either condition qualifies):
  //      a) days_to_sale < 0  (computed field confirmed past)
  //      b) days_to_sale IS NULL AND meta->saleDate is a past date
  //         (days_to_sale may not have been computed yet for newer imports)
  //    No surplus_estimate requirement -- use tier gate instead.
  // ─────────────────────────────────────────────────────────────────────────

  // Fetch candidate deals for condition (a): days_to_sale < 0
  // Note: death_signal filter is intentionally omitted for tier B (deceased is expected).
  const { data: surplusDealsA } = await sb
    .from('deals')
    .select('id, name, address, meta, days_to_sale, surplus_estimate, status, lead_tier')
    .in('lead_tier', ['A', 'B'])
    .eq('type', 'surplus')
    .is('deleted_at', null)
    .lt('days_to_sale', 0)

  // Fetch candidate deals for condition (b): days_to_sale IS NULL
  // We will filter by past saleDate in JS since meta is jsonb.
  const { data: surplusDealsB } = await sb
    .from('deals')
    .select('id, name, address, meta, days_to_sale, surplus_estimate, status, lead_tier')
    .in('lead_tier', ['A', 'B'])
    .eq('type', 'surplus')
    .is('deleted_at', null)
    .is('days_to_sale', null)

  // Merge, dedup by id, filter condition (b) by past saleDate
  const surplusMap = new Map<string, typeof surplusDealsA[0]>()
  for (const deal of (surplusDealsA || [])) {
    surplusMap.set(deal.id, deal)
  }
  for (const deal of (surplusDealsB || [])) {
    if (!surplusMap.has(deal.id) && saleDateIsInPast(deal.meta?.saleDate ?? null)) {
      surplusMap.set(deal.id, deal)
    }
  }

  for (const deal of surplusMap.values()) {
    // Skip terminal statuses
    if (EXCLUDED_STATUSES.has(deal.status)) {
      results.surplus_skipped.push(`${deal.id} (excluded status: ${deal.status})`)
      continue
    }

    // Skip deals already contacted by the old cadence
    if (priorOutreachDealIds.has(deal.id)) {
      results.surplus_skipped.push(`${deal.id} (prior sent outreach)`)
      continue
    }

    if (enrolledBySeq['ohio-surplus-v1'].has(deal.id)) {
      results.surplus_skipped.push(`${deal.id} (already enrolled)`)
      continue
    }

    // Phone: prefer meta, fall back to outreach_queue
    const rawPhone = deal.meta?.homeownerPhone?.trim() || fallbackPhoneMap.get(deal.id) || ''
    if (!rawPhone) {
      results.surplus_skipped.push(`${deal.id} (no phone)`)
      continue
    }

    // Name: prefer meta.homeownerName, fall back to deals.name column
    const rawName = deal.meta?.homeownerName?.trim() || (deal as any).name || ''
    const { first, last } = splitName(rawName)
    if (!first) {
      results.surplus_skipped.push(`${deal.id} (no name)`)
      continue
    }

    const saleDate = parseSaleDate(deal.meta?.saleDate)
    const county   = cleanCounty(deal.meta?.county)
    const street   = streetOnly(deal.address)
    const caseNum  = deal.meta?.courtCase || ''

    const contactData: Record<string, string | number> = {
      first_name:       first,
      last_name:        last,
      county:           county || 'your',
      street_address:   street || deal.address || '',
      case_number:      caseNum,
      case_month:       saleDate?.month  || '',
      case_year:        saleDate?.year   || '',
      agent_first_name: 'Nathan',
    }

    const enrollResp = await callRelayEnroll(supabaseUrl, serviceRoleKey, relaySecret, {
      sequence_id:   'ohio-surplus-v1',
      contact_phone: normalizePhone(rawPhone),
      deal_id:       deal.id,
      contact_data:  contactData,
    })

    if (enrollResp.ok) {
      results.surplus_enrolled.push(deal.id)
      console.log(`relay-auto-enroll: enrolled ${deal.id} into ohio-surplus-v1`)
    } else if (enrollResp.status === 409) {
      results.surplus_skipped.push(`${deal.id} (already enrolled - race)`)
    } else {
      const err = `HTTP ${enrollResp.status}: ${enrollResp.error}`
      results.errors.push({ deal_id: deal.id, error: err })
      console.error(`relay-auto-enroll: failed ${deal.id} surplus: ${err}`)
    }
  }

  const summary = {
    ok: true,
    preauction:  { enrolled: results.preauction_enrolled.length, skipped: results.preauction_skipped.length },
    surplus:     { enrolled: results.surplus_enrolled.length,    skipped: results.surplus_skipped.length    },
    errors:      results.errors.length,
    detail:      results,
  }

  console.log('relay-auto-enroll complete:', JSON.stringify(summary))
  return json(summary)
})

// ── Helper: call relay-enroll ─────────────────────────────────────────────
async function callRelayEnroll(
  supabaseUrl: string,
  serviceRoleKey: string,
  relaySecret: string | undefined,
  payload: {
    sequence_id: string
    contact_phone: string
    deal_id: string
    contact_data: Record<string, unknown>
  }
): Promise<{ ok: boolean; status: number; error?: string }> {
  try {
    const headers: Record<string, string> = {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${serviceRoleKey}`,
    }
    if (relaySecret) headers['x-relay-secret'] = relaySecret

    const resp = await fetch(`${supabaseUrl}/functions/v1/relay-enroll`, {
      method:  'POST',
      headers,
      body:    JSON.stringify(payload),
    })

    if (resp.ok || resp.status === 409) {
      return { ok: resp.ok, status: resp.status }
    }

    const body = await resp.json().catch(() => ({}))
    return { ok: false, status: resp.status, error: body?.error || resp.statusText }
  } catch (e) {
    return { ok: false, status: 0, error: (e as Error).message }
  }
}
