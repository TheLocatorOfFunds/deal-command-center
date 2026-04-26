import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

/**
 * Split a message into segments of at most `limit` characters.
 * Splits at sentence-ending punctuation (period or question mark) only —
 * meaning the character after the punctuation must be a space followed by
 * an uppercase letter, or end-of-text, to avoid splitting on abbreviations.
 * Falls back to last whitespace (word boundary), then hard-cuts as last resort.
 * A single-segment message is returned as-is without modification.
 */
function splitAtPunctuation(text: string, limit = 160): string[] {
  const trimmed = text.trim()
  if (trimmed.length <= limit) return [trimmed]

  const segments: string[] = []
  let remaining = trimmed

  while (remaining.length > limit) {
    const chunk = remaining.slice(0, limit)

    // Search backwards for '. ' or '? ' where the next char is uppercase (sentence boundary)
    // Also accept end-of-chunk as a valid boundary.
    let splitIdx = -1
    for (let i = chunk.length - 1; i >= 0; i--) {
      const ch   = chunk[i]
      const next = chunk[i + 1]  // char immediately after punctuation
      const after = chunk[i + 2] // char after the space
      const isSentenceEnd = ch === '.' || ch === '?'
      const followedByEndOrCapital =
        next === undefined ||                            // end of chunk
        (next === ' ' && (after === undefined || (after >= 'A' && after <= 'Z')))
      if (isSentenceEnd && followedByEndOrCapital) {
        splitIdx = i + 1  // include the punctuation, split after it
        break
      }
    }

    // Fall back to last whitespace (word boundary)
    if (splitIdx === -1) {
      for (let i = chunk.length - 1; i >= 0; i--) {
        if (chunk[i] === ' ' || chunk[i] === '\n') {
          splitIdx = i
          break
        }
      }
    }

    // Last resort: hard cut at limit
    if (splitIdx === -1) splitIdx = limit

    segments.push(remaining.slice(0, splitIdx).trim())
    remaining = remaining.slice(splitIdx).trim()
  }

  if (remaining) segments.push(remaining)
  return segments
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

    const { to: toRaw, body, deal_id, from_number, contact_id } = await req.json()

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

    // ────────────────────────────────────────────────────────────────────
    // DND check (added 2026-04-25 by Nathan's session — see WORKING_ON.md)
    // If the recipient phone is on contacts.do_not_text=true, refuse to
    // send. Returns 403 + structured error so the caller (UI / cadence
    // engine) can mark the queue row 'cancelled' with a clear reason.
    // ────────────────────────────────────────────────────────────────────
    const bareTo = to.replace(/^\+1/, '')
    const { data: dndRows } = await sb
      .from('contacts')
      .select('id, phone, do_not_text, dnd_reason')
      .or(`phone.eq.${to},phone.eq.${bareTo}`)
      .eq('do_not_text', true)
      .limit(1)
    if (dndRows && dndRows.length > 0) {
      return new Response(JSON.stringify({
        error: 'recipient_on_dnd',
        details: dndRows[0].dnd_reason || 'do_not_text=true',
        contact_id: dndRows[0].id,
      }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }
    // ────────────────────────────────────────────────────────────────────

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

    // Split body at punctuation boundaries if over 160 chars
    const segments = splitAtPunctuation(body)
    const isSplit  = segments.length > 1
    const channel  = gateway === 'mac_bridge' ? 'imessage' : 'sms'
    const threadKey = deal_id
      ? (contact_id ? `${deal_id}:contact:${contact_id}` : `${deal_id}:phone:${to}`)
      : null

    // Insert a messages_outbound row for each segment
    const initialStatus = gateway === 'mac_bridge' ? 'pending_mac' : 'queued'
    const insertedIds: string[] = []

    for (const segment of segments) {
      const { data: msgRow, error: insertError } = await sb
        .from('messages_outbound')
        .insert({
          to_number:   to,
          from_number: resolvedFrom,
          body:        segment,
          status:      initialStatus,
          sent_by:     userId,
          deal_id:     deal_id ?? null,
          contact_id:  contact_id ?? null,
          channel,
          thread_key:  threadKey,
        })
        .select()
        .single()

      if (insertError) {
        return new Response(JSON.stringify({ error: insertError.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }
      insertedIds.push(msgRow.id)
    }

    // ── mac_bridge path: return immediately, bridge handles delivery ──────────
    if (gateway === 'mac_bridge') {
      return new Response(
        JSON.stringify({ id: insertedIds[0], ids: insertedIds, parts: segments.length, status: 'pending_mac' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ── Twilio path: send each segment sequentially ───────────────────────────
    const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${twilioAccountSid}/Messages.json`
    let lastStatus = 'sent'

    for (let i = 0; i < segments.length; i++) {
      const twilioRes = await fetch(twilioUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${btoa(`${twilioAccountSid}:${twilioAuthToken}`)}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: to, From: resolvedFrom, Body: segments[i] }).toString(),
      })

      const twilioData = await twilioRes.json()

      const updateFields = twilioRes.ok
        ? { status: 'sent', twilio_sid: twilioData.sid }
        : {
            status: 'failed',
            error_code: String(twilioData.code ?? ''),
            error_message: twilioData.message ?? 'Unknown Twilio error',
          }

      await sb.from('messages_outbound').update(updateFields).eq('id', insertedIds[i])
      if (!twilioRes.ok) lastStatus = 'failed'
    }

    return new Response(
      JSON.stringify({ id: insertedIds[0], ids: insertedIds, parts: segments.length, status: lastStatus }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
