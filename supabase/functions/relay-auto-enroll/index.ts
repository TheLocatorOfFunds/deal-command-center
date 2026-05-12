import { createClient } from 'jsr:@supabase/supabase-js@2'

/**
 * relay-auto-enroll — Scans deals and enrolls eligible ones into FL Relay sequences.
 *
 * Called by pg_cron every 15 minutes. Handles two sequences:
 *
 *   ohio-preauction-v1:
 *     Trigger: deal.is_30dts = true (auction within 30 days)
 *     Eligibility: lead_tier='A', death_signal=false, phone present,
 *                  not already enrolled, not deleted
 *
 *   ohio-surplus-v1:
 *     Trigger: deal.days_to_sale < 0 (auction already happened)
 *     Eligibility: lead_tier='A', death_signal=false, surplus_estimate > 0,
 *                  phone present, not already enrolled, not deleted
 *
 * Note on the Ohio Intel grading agent: the agent-side grade (A/B/C/drop)
 * in meta.grade is not yet populated because the BatchData valuation pipeline
 * (Phase 6) is still blocked. Until that pipeline is live, we use DCC's own
 * lead_tier field as the eligibility gate. Once meta.grade is populated, we
 * can layer that in as an additional filter here.
 *
 * Contact data mapping from deals:
 *   first_name       <- first word of meta.homeownerName
 *   last_name        <- rest of meta.homeownerName
 *   county           <- meta.county (stripped of " County" suffix)
 *   street_address   <- deals.address (street portion only, before first comma)
 *   case_number      <- meta.courtCase
 *   auction_date     <- meta.saleDate formatted as "Month D, YYYY"
 *   days_until_auction <- deals.days_to_sale
 *   case_month       <- month name from meta.saleDate (for surplus sequence)
 *   case_year        <- year from meta.saleDate
 *   agent_first_name <- 'Nathan' (default)
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

  const supabaseUrl    = Deno.env.get('SUPABASE_URL')!
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const relaySecret    = Deno.env.get('RELAY_SECRET')

  const headerSecret = req.headers.get('x-relay-secret') || ''
  if (relaySecret && headerSecret !== relaySecret) {
    return json({ error: 'unauthorized' }, 401)
  }

  const sb = createClient(supabaseUrl, serviceRoleKey)

  // ── Fetch already-enrolled deal IDs per sequence ──────────────────────────
  // Used to skip deals we've already enrolled so we don't call relay-enroll
  // unnecessarily (relay-enroll would return 409, but better to skip upfront).
  const { data: existingEnrollments } = await sb
    .schema('relay')
    .from('enrollments')
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

  const results = {
    preauction_enrolled:  [] as string[],
    preauction_skipped:   [] as string[],
    surplus_enrolled:     [] as string[],
    surplus_skipped:      [] as string[],
    errors:               [] as { deal_id: string; error: string }[],
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 1. PRE-AUCTION TRIGGER
  //    is_30dts = true, lead_tier = 'A', not deceased, phone present
  // ─────────────────────────────────────────────────────────────────────────
  const { data: preAuctionDeals } = await sb
    .from('deals')
    .select('id, address, meta, days_to_sale, surplus_estimate')
    .eq('lead_tier', 'A')
    .eq('is_30dts', true)
    .eq('death_signal', false)
    .eq('type', 'surplus')
    .is('deleted_at', null)

  for (const deal of (preAuctionDeals || [])) {
    const phone = deal.meta?.homeownerPhone
    if (!phone || !phone.trim()) {
      results.preauction_skipped.push(`${deal.id} (no phone)`)
      continue
    }

    if (enrolledBySeq['ohio-preauction-v1'].has(deal.id)) {
      results.preauction_skipped.push(`${deal.id} (already enrolled)`)
      continue
    }

    const { first, last } = splitName(deal.meta?.homeownerName)
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
      contact_phone: normalizePhone(phone),
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
  // 2. POST-AUCTION / SURPLUS TRIGGER
  //    days_to_sale < 0, lead_tier = 'A', surplus_estimate > 0, not deceased
  // ─────────────────────────────────────────────────────────────────────────
  const { data: surplusDeals } = await sb
    .from('deals')
    .select('id, address, meta, days_to_sale, surplus_estimate')
    .eq('lead_tier', 'A')
    .eq('death_signal', false)
    .eq('type', 'surplus')
    .is('deleted_at', null)
    .lt('days_to_sale', 0)        // auction already happened
    .gt('surplus_estimate', 0)    // surplus amount confirmed > 0

  for (const deal of (surplusDeals || [])) {
    const phone = deal.meta?.homeownerPhone
    if (!phone || !phone.trim()) {
      results.surplus_skipped.push(`${deal.id} (no phone)`)
      continue
    }

    if (enrolledBySeq['ohio-surplus-v1'].has(deal.id)) {
      results.surplus_skipped.push(`${deal.id} (already enrolled)`)
      continue
    }

    const { first, last } = splitName(deal.meta?.homeownerName)
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
      contact_phone: normalizePhone(phone),
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

// ── Helper: call relay-enroll ─────────────────────────────────────────────────
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
