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

    // Try to find which deal this contact belongs to (homeowner phone or vendor phone)
    let dealId: string | null = null
    const { data: dealRow } = await sb
      .from('deals')
      .select('id')
      .eq('meta->>homeownerPhone', from)
      .limit(1)
      .single()
    if (dealRow) {
      dealId = dealRow.id
    } else {
      const { data: vendorRow } = await sb
        .from('vendors')
        .select('deal_id')
        .eq('phone', from)
        .limit(1)
        .single()
      if (vendorRow) dealId = vendorRow.deal_id
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
