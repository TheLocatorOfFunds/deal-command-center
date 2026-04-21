import { createClient } from 'jsr:@supabase/supabase-js@2'

// Twilio sends no JWT — this function must be deployed with --no-verify-jwt
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' },
    })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const sb = createClient(supabaseUrl, serviceRoleKey)

    // Twilio sends form-encoded data
    const text = await req.text()
    const params = new URLSearchParams(text)

    const fromRaw = params.get('From') ?? ''   // contact's number
    const toRaw   = params.get('To')   ?? ''   // our Twilio number
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

    const bare = from.replace(/^\+1/, '')  // 10-digit form without country code
    let dealId: string | null = null

    // Primary heuristic: use the deal we most recently SENT a message to this number.
    // If the same contact is in multiple deals, the reply almost certainly belongs
    // to the conversation that was most recently active.
    const { data: recentOutbound } = await sb
      .from('messages_outbound')
      .select('deal_id')
      .in('to_number', [from, bare])
      .eq('direction', 'outbound')
      .not('deal_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .single()
    if (recentOutbound) {
      dealId = recentOutbound.deal_id
    }

    // Fallback: find deal by homeowner phone or vendor phone
    if (!dealId) {
      const { data: dealRow } = await sb.rpc('find_deal_by_phone', { phone_e164: from, phone_bare: bare })
      if (dealRow && dealRow.length > 0) {
        dealId = dealRow[0].id
      } else {
        const { data: vendorRow } = await sb
          .from('vendors')
          .select('deal_id')
          .or(`phone.eq.${from},phone.eq.${bare}`)
          .limit(1)
          .single()
        if (vendorRow) dealId = vendorRow.deal_id
      }
    }

    // Store inbound message — use to_number = contact's number so UI thread filter works
    await sb.from('messages_outbound').insert({
      to_number:   from,   // contact's number (thread key)
      from_number: to,     // our Twilio number
      body,
      direction:   'inbound',
      status:      'received',
      twilio_sid:  sid,
      deal_id:     dealId,
    })

    // Return empty TwiML so Twilio doesn't auto-reply
    return new Response('<Response/>', {
      headers: { 'Content-Type': 'text/xml' },
    })
  } catch (err) {
    console.error('receive-sms error:', err)
    return new Response('<Response/>', {
      headers: { 'Content-Type': 'text/xml' },
    })
  }
})
