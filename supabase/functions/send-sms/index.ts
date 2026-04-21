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
    // Gateway already verified JWT (verify_jwt: true).
    // Decode the sub claim directly to get the user ID without an extra API round-trip.
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
      const payload = JSON.parse(atob(token.split('.')[1]))
      userId = payload.sub
      if (!userId) throw new Error('no sub')
    } catch {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const twilioAccountSid = Deno.env.get('TWILIO_ACCOUNT_SID')!
    const twilioAuthToken = Deno.env.get('TWILIO_AUTH_TOKEN')!
    const twilioFromNumber = Deno.env.get('TWILIO_FROM_NUMBER')!

    const sb = createClient(supabaseUrl, serviceRoleKey)

    const { to, body, deal_id, from_number } = await req.json()

    if (!to || !body) {
      return new Response(JSON.stringify({ error: 'Missing required fields: to, body' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Resolve from_number: use client-supplied value if it's in phone_numbers, else fall back to env
    let resolvedFrom = twilioFromNumber
    if (from_number) {
      const { data: phoneRow } = await sb
        .from('phone_numbers')
        .select('number')
        .eq('number', from_number)
        .eq('active', true)
        .single()
      if (phoneRow) resolvedFrom = phoneRow.number
    }

    // Insert queued row immediately so UI can show it
    const { data: msgRow, error: insertError } = await sb
      .from('messages_outbound')
      .insert({
        to_number: to,
        from_number: resolvedFrom,
        body,
        status: 'queued',
        sent_by: userId,
        deal_id: deal_id ?? null,
      })
      .select()
      .single()

    if (insertError) {
      return new Response(JSON.stringify({ error: insertError.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Call Twilio Messages API
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

    await sb
      .from('messages_outbound')
      .update(updateFields)
      .eq('id', msgRow.id)

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
