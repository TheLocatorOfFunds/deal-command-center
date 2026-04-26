import { createClient } from 'jsr:@supabase/supabase-js@2'

// ────────────────────────────────────────────────────────────────────
// HEADS UP for Justin's Claude session — modified 2026-04-25 by Nathan's session
// ────────────────────────────────────────────────────────────────────
// Added STOP-keyword silent DND handler at the bottom of the success path:
// when an inbound body matches STOP/UNSUBSCRIBE/QUIT/END/CANCEL/'OPT OUT',
// the matching contacts row gets do_not_text=true AND do_not_call=true
// (both new columns added in migration 20260425020000), all pending/queued
// outreach_queue rows for that contact_phone get cancelled, and an activity
// row of type='dnc_optout' is logged.
//
// Per Nathan's directive 2026-04-25: NO app-level reply. Twilio's
// carrier-level Advanced Opt-Out emits the bare-minimum confirmation
// ("Unsubscribed. No more messages." — set at messaging service level)
// and that's it. Our code stays silent after flipping the flags.
//
// Nathan's framing: he's the human physically operating his iPhone via DCC;
// the system is a typing assistant. Sender-reputation compliance lives at
// the Twilio messaging-service config layer, not in this code.
//
// Nothing else in receive-sms changed. The existing matching/routing logic
// (lines 36-101) is untouched.
// ────────────────────────────────────────────────────────────────────

const STOP_KEYWORDS = new Set([
  'stop', 'unsubscribe', 'quit', 'end', 'cancel', 'opt out', 'optout', 'stop all',
])

function isStopKeyword(body: string): boolean {
  const trimmed = (body || '').trim().toLowerCase()
  if (!trimmed) return false
  if (STOP_KEYWORDS.has(trimmed)) return true
  // Also catch single-word STOP at the start of multi-word messages
  const firstWord = trimmed.split(/\s+/)[0]
  return STOP_KEYWORDS.has(firstWord)
}

// Twilio sends no JWT — this function must be deployed with --no-verify-jwt
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' },
    })
  }

  try {
    const supabaseUrl    = Deno.env.get('SUPABASE_URL')!
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const sb             = createClient(supabaseUrl, serviceRoleKey)

    // Twilio sends form-encoded data
    const text   = await req.text()
    const params = new URLSearchParams(text)

    const fromRaw = params.get('From') ?? ''   // contact's number
    const toRaw   = params.get('To')   ?? ''   // our Twilio/Nathan number
    const body    = params.get('Body') ?? ''
    const sid     = params.get('MessageSid') ?? ''

    // Normalize to E.164
    const normalize = (p: string) => {
      const d = p.replace(/\D/g, '')
      if (d.length === 10) return `+1${d}`
      if (d.length === 11 && d.startsWith('1')) return `+${d}`
      return p
    }
    const from = normalize(fromRaw)
    const to   = normalize(toRaw)
    const bare = from.replace(/^\+1/, '')   // 10-digit without country code

    // ── Routing: find deal + contact for this inbound number ──────────────────

    let dealId:    string | null = null
    let contactId: string | null = null
    let threadKey: string | null = null

    // 1. Match by contacts.phone → contact_deals → deal
    //    Prefer the most recently active deal if the contact is on multiple.
    const { data: contactRows } = await sb
      .from('contacts')
      .select('id, contact_deals(deal_id)')
      .or(`phone.eq.${from},phone.eq.${bare}`)
      .limit(5)

    if (contactRows && contactRows.length > 0) {
      const c = contactRows[0]
      contactId = c.id
      // Pick the deal we most recently messaged this contact on
      const dealIds = (c.contact_deals as { deal_id: string }[]).map(r => r.deal_id)
      if (dealIds.length === 1) {
        dealId = dealIds[0]
      } else if (dealIds.length > 1) {
        const { data: recent } = await sb
          .from('messages_outbound')
          .select('deal_id')
          .in('deal_id', dealIds)
          .eq('direction', 'outbound')
          .not('deal_id', 'is', null)
          .order('created_at', { ascending: false })
          .limit(1)
          .single()
        dealId = recent?.deal_id ?? dealIds[0]
      }
      if (dealId && contactId) {
        threadKey = `${dealId}:contact:${contactId}`
      }
    }

    // 2. Fallback: match homeowner phone on deal.meta
    if (!dealId) {
      const { data: dealRow } = await sb.rpc('find_deal_by_phone', { phone_e164: from, phone_bare: bare })
      if (dealRow && dealRow.length > 0) {
        dealId = dealRow[0].id
        threadKey = `${dealId}:phone:${from}`
      }
    }

    // 3. Fallback: most-recent outbound to this number (legacy heuristic)
    if (!dealId) {
      const { data: recentOutbound } = await sb
        .from('messages_outbound')
        .select('deal_id, contact_id')
        .in('to_number', [from, bare])
        .eq('direction', 'outbound')
        .not('deal_id', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .single()
      if (recentOutbound) {
        dealId    = recentOutbound.deal_id
        contactId = contactId ?? recentOutbound.contact_id
        threadKey = contactId
          ? `${dealId}:contact:${contactId}`
          : `${dealId}:phone:${from}`
      }
    }

    // 4. No match — land in unmatched queue for triage
    if (!dealId) {
      await sb.from('messages_outbound_unmatched').insert({
        from_number:  from,
        to_number:    to,
        body,
        raw_payload:  Object.fromEntries(params.entries()),
        received_at:  new Date().toISOString(),
      })
      return new Response('<Response/>', { headers: { 'Content-Type': 'text/xml' } })
    }

    // ── Store inbound message ─────────────────────────────────────────────────
    await sb.from('messages_outbound').insert({
      to_number:   from,      // contact's number (thread filter key)
      from_number: to,        // our number
      body,
      direction:   'inbound',
      status:      'received',
      twilio_sid:  sid || null,
      deal_id:     dealId,
      contact_id:  contactId,
      thread_key:  threadKey,
      channel:     'sms',
    })

    // ── STOP keyword → silent DND (Nathan's directive 2026-04-25) ──
    // Carrier-level Advanced Opt-Out at Twilio MS handles the single
    // required confirmation; this code does total app-side DND on top.
    if (isStopKeyword(body)) {
      const dndPatch = {
        do_not_text: true,
        do_not_call: true,
        dnd_set_at: new Date().toISOString(),
        dnd_reason: `STOP keyword inbound on ${new Date().toISOString().slice(0, 10)} from ${from}`,
      }
      if (contactId) {
        await sb.from('contacts').update(dndPatch).eq('id', contactId)
      } else {
        // No contact row exists for this number — create a stub so future
        // sends are still blocked. Match by phone is what filters check.
        await sb.from('contacts').insert({
          name: from,
          phone: from,
          kind: 'other',
          ...dndPatch,
          notes: 'Auto-created from STOP-keyword inbound. No prior contact record.',
        })
      }
      // Cancel any pending/queued cadence rows for this number
      await sb.from('outreach_queue')
        .update({ status: 'cancelled', skipped_reason: 'dnc_optout', updated_at: new Date().toISOString() })
        .eq('contact_phone', from)
        .in('status', ['queued', 'generating', 'pending'])
      // Log to activity feed for Nathan's audit trail
      if (dealId) {
        await sb.from('activity').insert({
          deal_id: dealId,
          action: `dnc_optout: STOP keyword from ${from}`,
        })
      }
    }

    // Return empty TwiML so Twilio doesn't auto-reply (Twilio's carrier-level
    // Advanced Opt-Out emits the required STOP confirmation independently)
    return new Response('<Response/>', { headers: { 'Content-Type': 'text/xml' } })

  } catch (err) {
    console.error('receive-sms error:', err)
    return new Response('<Response/>', { headers: { 'Content-Type': 'text/xml' } })
  }
})
