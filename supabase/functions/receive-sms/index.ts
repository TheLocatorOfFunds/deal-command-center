import { createClient } from 'jsr:@supabase/supabase-js@2'

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

    // Return empty TwiML so Twilio doesn't auto-reply
    return new Response('<Response/>', { headers: { 'Content-Type': 'text/xml' } })

  } catch (err) {
    console.error('receive-sms error:', err)
    return new Response('<Response/>', { headers: { 'Content-Type': 'text/xml' } })
  }
})
