import { createClient } from 'jsr:@supabase/supabase-js@2'

/**
 * drop-rvm — drops a ringless voicemail via Drop Cowboy v2 API.
 *
 * Request body:
 *   {
 *     to:          string,          // recipient phone (E.164 or 10-digit US)
 *     audio_url:   string,          // publicly accessible .mp3 / .wav URL
 *     caller_id?:  string,          // outbound caller ID (defaults to FROM_NUMBER secret)
 *     deal_id?:    string,          // links the drop to a deal in messages_outbound
 *     contact_id?: string,          // links to a contact
 *     template?:   string,          // optional template name (for logging only)
 *   }
 *
 * Setup:
 *   1. Set DROP_COWBOY_TOKEN in Edge Function secrets (Supabase Dashboard → Secrets)
 *   2. Set DROP_COWBOY_FROM_NUMBER (the caller ID registered in your Drop Cowboy account)
 *   3. Deploy: supabase functions deploy drop-rvm --no-verify-jwt --project-ref rcfaashkfpurkvtmsmeb
 *
 * Drop Cowboy v2 docs: https://docs.dropcowboy.com/v2
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const supabaseUrl      = Deno.env.get('SUPABASE_URL')!
  const serviceRoleKey   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const dcToken          = Deno.env.get('DROP_COWBOY_TOKEN')
  const dcFromNumber     = Deno.env.get('DROP_COWBOY_FROM_NUMBER')

  if (!dcToken) {
    return new Response(JSON.stringify({ error: 'DROP_COWBOY_TOKEN not configured — set it in Supabase Edge Function secrets' }), {
      status: 503,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  try {
    // Decode user from Bearer token (same pattern as send-sms)
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

    const sb = createClient(supabaseUrl, serviceRoleKey)
    const body = await req.json()
    const { to: toRaw, audio_url, caller_id, deal_id, contact_id, template } = body

    if (!toRaw || !audio_url) {
      return new Response(JSON.stringify({ error: 'Missing required fields: to, audio_url' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Normalize recipient to E.164
    const digits = toRaw.replace(/\D/g, '')
    const to = digits.length === 10 ? `+1${digits}`
             : digits.length === 11 && digits.startsWith('1') ? `+${digits}`
             : toRaw

    const resolvedCallerId = caller_id || dcFromNumber || ''

    // ── Insert pending record before sending ──────────────────────────────
    const { data: msgRow, error: insertError } = await sb
      .from('messages_outbound')
      .insert({
        to_number:   to,
        from_number: resolvedCallerId,
        body:        template ? `[RVM] ${template}` : '[RVM] Ringless voicemail dropped',
        status:      'queued',
        sent_by:     userId,
        deal_id:     deal_id ?? null,
        contact_id:  contact_id ?? null,
        channel:     'rvm',
        direction:   'outbound',
      })
      .select()
      .single()

    if (insertError) {
      return new Response(JSON.stringify({ error: insertError.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ── Call Drop Cowboy v2 API ───────────────────────────────────────────
    // Docs: https://docs.dropcowboy.com/v2#section/Introduction
    const dcPayload: Record<string, string> = {
      recipient_phone_number: to,
      audio_file_url:         audio_url,
    }
    if (resolvedCallerId) dcPayload.caller_id = resolvedCallerId

    const dcRes = await fetch('https://api.dropcowboy.com/v2/ringless_voicemail_drops', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${dcToken}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(dcPayload),
    })

    const dcData = await dcRes.json()

    if (!dcRes.ok) {
      // Mark failed in DB
      await sb.from('messages_outbound')
        .update({ status: 'failed', error_message: dcData?.message || dcData?.error || 'Drop Cowboy error' })
        .eq('id', msgRow.id)

      return new Response(JSON.stringify({
        error: dcData?.message || dcData?.error || 'Drop Cowboy API error',
        dc_response: dcData,
      }), {
        status: dcRes.status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ── Success: mark sent, store Drop Cowboy drop ID ─────────────────────
    const dropId = dcData?.id ?? dcData?.drop_id ?? dcData?.data?.id ?? null
    await sb.from('messages_outbound')
      .update({
        status:     'sent',
        twilio_sid: dropId ? `dc_${dropId}` : null,  // reuse twilio_sid column for the DC drop ID
      })
      .eq('id', msgRow.id)

    console.log(`✅ RVM dropped  to=${to}  drop_id=${dropId}  deal=${deal_id ?? 'none'}`)

    return new Response(JSON.stringify({
      ok:      true,
      id:      msgRow.id,
      drop_id: dropId,
      to,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
