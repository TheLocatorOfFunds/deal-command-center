import { createClient } from 'jsr:@supabase/supabase-js@2'

/**
 * quo-webhook — receives call.completed events from Quo (formerly OpenPhone)
 *
 * Setup in Quo dashboard:
 *   Integrations → Webhooks → Add endpoint
 *   URL: https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/quo-webhook
 *   Events: call.completed, call.missed, call.voicemail.completed
 *
 * This function must be deployed with --no-verify-jwt since Quo sends no JWT.
 * Requests are authenticated via the QUO_WEBHOOK_SECRET env var (set in Quo).
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const supabaseUrl    = Deno.env.get('SUPABASE_URL')!
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const anthropicKey   = Deno.env.get('ANTHROPIC_API_KEY') ?? null
  const webhookSecret  = Deno.env.get('QUO_WEBHOOK_SECRET') ?? null

  const sb = createClient(supabaseUrl, serviceRoleKey)

  try {
    // Verify Quo webhook secret if configured
    if (webhookSecret) {
      const signature = req.headers.get('x-openphone-signature') ?? req.headers.get('x-quo-signature') ?? ''
      if (signature !== webhookSecret) {
        return new Response(JSON.stringify({ error: 'Invalid signature' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }
    }

    const payload = await req.json()
    const { event, data } = payload

    // Only handle call events
    if (!event?.startsWith('call.')) {
      return new Response(JSON.stringify({ ok: true, skipped: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Normalise the Quo payload — field names can vary slightly by event type
    const call       = data?.object ?? data ?? {}
    const quoCallId  = call.id ?? call.callId ?? payload.callId
    const direction  = call.direction === 'incoming' ? 'inbound' : 'outbound'
    const fromRaw    = call.from ?? call.fromNumber ?? ''
    const toRaw      = call.to   ?? call.toNumber   ?? ''
    const calledAt   = call.createdAt ?? call.startedAt ?? new Date().toISOString()
    const duration   = call.duration ?? null          // seconds
    const status     = event === 'call.missed' ? 'missed'
                     : event.includes('voicemail')    ? 'voicemail'
                     : 'completed'
    const recordingUrl = call.recording?.url ?? call.recordingUrl ?? null
    const transcript   = call.transcript?.text ?? call.transcription ?? null

    if (!quoCallId) {
      console.error('No call ID in payload', payload)
      return new Response(JSON.stringify({ error: 'Missing call ID' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Normalise phone numbers to E.164
    const normalize = (p: string) => {
      if (!p) return null
      const d = p.replace(/\D/g, '')
      if (d.length === 10) return `+1${d}`
      if (d.length === 11 && d.startsWith('1')) return `+${d}`
      return p || null
    }
    const fromNumber = normalize(fromRaw)
    const toNumber   = normalize(toRaw)

    // Match to a deal — the contact's number is from_number for inbound, to_number for outbound
    const contactPhone = direction === 'inbound' ? fromNumber : toNumber
    let dealId:    string | null = null
    let contactId: string | null = null

    if (contactPhone) {
      const bare = contactPhone.replace(/^\+1/, '')

      // 1. Try contacts table
      const { data: contactRows } = await sb
        .from('contacts')
        .select('id, contact_deals(deal_id)')
        .or(`phone.eq.${contactPhone},phone.eq.${bare}`)
        .limit(1)
      if (contactRows && contactRows.length > 0) {
        contactId = contactRows[0].id
        const deals = (contactRows[0].contact_deals as { deal_id: string }[])
        dealId = deals?.[0]?.deal_id ?? null
      }

      // 2. Fallback: find_deal_by_phone RPC (checks homeowner + vendors too)
      if (!dealId) {
        const { data: dealRows } = await sb.rpc('find_deal_by_phone', {
          phone_e164: contactPhone,
          phone_bare: bare,
        })
        dealId = dealRows?.[0]?.id ?? null
      }
    }

    // Upsert into call_recordings (idempotent on quo_call_id)
    const { data: recRow, error: insertError } = await sb
      .from('call_recordings')
      .upsert({
        quo_call_id:  quoCallId,
        deal_id:      dealId,
        contact_id:   contactId,
        direction,
        from_number:  fromNumber,
        to_number:    toNumber,
        duration_seconds: duration,
        status,
        called_at:    calledAt,
        recording_url: recordingUrl,
        transcript,
        raw_payload:  payload,
      }, { onConflict: 'quo_call_id' })
      .select()
      .single()

    if (insertError) {
      console.error('Insert error:', insertError)
      return new Response(JSON.stringify({ error: insertError.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Generate AI summary if we have a transcript and Anthropic key
    if (transcript && anthropicKey && recRow?.id) {
      try {
        const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key':         anthropicKey,
            'anthropic-version': '2023-06-01',
            'content-type':      'application/json',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5',
            max_tokens: 512,
            messages: [{
              role: 'user',
              content: `You are summarizing a business call for a surplus fund recovery case. Be concise.

Transcript:
${transcript}

Return a JSON object with:
- "summary": 2-3 sentence plain English summary of what was discussed
- "action_items": array of strings, specific next steps mentioned (empty array if none)
- "sentiment": "positive" | "neutral" | "negative" | "urgent"

JSON only, no other text.`,
            }],
          }),
        })
        const aiData = await aiRes.json()
        const raw = aiData?.content?.[0]?.text ?? ''
        let parsed: { summary?: string; action_items?: string[]; sentiment?: string } = {}
        try { parsed = JSON.parse(raw) } catch { /* ignore parse errors */ }

        await sb.from('call_recordings').update({
          ai_summary:      parsed.summary      ?? null,
          ai_action_items: parsed.action_items?.join('\n') ?? null,
          ai_processed_at: new Date().toISOString(),
        }).eq('id', recRow.id)
      } catch (aiErr) {
        console.error('AI summary error (non-fatal):', aiErr)
      }
    }

    console.log(`✅ call.${status} quoId=${quoCallId} deal=${dealId ?? 'unmatched'} duration=${duration}s`)

    return new Response(JSON.stringify({ ok: true, id: recRow?.id, deal_id: dealId }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (err) {
    console.error('quo-webhook error:', err)
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
