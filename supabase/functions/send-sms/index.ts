import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing authorization' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const token = authHeader.replace('Bearer ', '')
    let userId: string
    try {
      const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
      const payload = JSON.parse(atob(b64))
      userId = payload.sub
      if (!userId) throw new Error('no sub')
    } catch {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const supabaseUrl      = Deno.env.get('SUPABASE_URL')!
    const serviceRoleKey   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const twilioAccountSid = Deno.env.get('TWILIO_ACCOUNT_SID')!
    const twilioAuthToken  = Deno.env.get('TWILIO_AUTH_TOKEN')!
    const twilioFromNumber = Deno.env.get('TWILIO_FROM_NUMBER')!

    const sb = createClient(supabaseUrl, serviceRoleKey)

    const { to: toRaw, body, deal_id, from_number } = await req.json()

    if (!toRaw || !body) {
      return new Response(JSON.stringify({ error: 'Missing required fields: to, body' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Normalize recipient to E.164
    const digits = toRaw.replace(/\D/g, '')
    const to = digits.length === 10 ? `+1${digits}`
             : digits.length === 11 && digits.startsWith('1') ? `+${digits}`
             : toRaw

    // Resolve from_number + check gateway (twilio vs mac_bridge)
    let resolvedFrom = twilioFromNumber
    let gateway      = 'twilio'
    if (from_number) {
      const { data: phoneRow } = await sb
        .from('phone_numbers')
        .select('number, gateway')
        .eq('number', from_number)
        .eq('active', true)
        .single()
      if (phoneRow) {
        resolvedFrom = phoneRow.number
        gateway      = phoneRow.gateway ?? 'twilio'
      }
    }

    // Insert row — status depends on gateway:
    //   twilio     → 'queued'      (Twilio call follows)
    //   mac_bridge → 'pending_mac' (Mac Mini bridge picks it up and sends via Messages.app)
    const initialStatus = gateway === 'mac_bridge' ? 'pending_mac' : 'queued'

    const { data: msgRow, error: insertError } = await sb
      .from('messages_outbound')
      .insert({
        to_number:   to,
        from_number: resolvedFrom,
        body,
        status:      initialStatus,
        sent_by:     userId,
        deal_id:     deal_id ?? null,
      })
      .select()
      .single()

    if (insertError) {
      return new Response(JSON.stringify({ error: insertError.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ── mac_bridge path: return immediately, bridge handles delivery ──────────
    if (gateway === 'mac_bridge') {
      return new Response(
        JSON.stringify({ id: msgRow.id, status: 'pending_mac' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ── Twilio path ───────────────────────────────────────────────────────────
    const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${twilioAccountSid}/Messages.json`
    const twilioRes = await fetch(twilioUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${btoa(`${twilioAccountSid}:${twilioAuthToken}`)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: resolvedFrom, Body: body }).toString(),
    })

    const twilioData = await twilioRes.json()

    const updateFields = twilioRes.ok
      ? { status: 'sent', twilio_sid: twilioData.sid }
      : {
          status: 'failed',
          error_code: String(twilioData.code ?? ''),
          error_message: twilioData.message ?? 'Unknown Twilio error',
        }

    await sb.from('messages_outbound').update(updateFields).eq('id', msgRow.id)

    return new Response(
      JSON.stringify({ id: msgRow.id, ...updateFields }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
