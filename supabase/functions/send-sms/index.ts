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

    const { to: toRaw, body, deal_id, from_number, contact_id, media_url } = await req.json()

    if (!toRaw || (!body && !media_url)) {
      return new Response(JSON.stringify({ error: 'Missing required fields: to, and at least one of body or media_url' }), {
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
    // Self-send guard. If `to` matches any active sender in phone_numbers
    // (5440 / 2306 / any future line), refuse outright. Twilio would
    // reject anyway with "'To' and 'From' number cannot be the same", but:
    //   - that came back AFTER the row was inserted as 'queued', so the
    //     mobile UI saw a 200 OK and lied "Sent" while the row got
    //     updated to 'failed' a moment later (bug 1, 2026-06-05).
    //   - this gate also blocks the mac_bridge fallback case where the
    //     recipient typo'd 2306 (Nathan's iPhone) into a thread.
    // Block BEFORE row insert so there is no failed row to clean up.
    // ────────────────────────────────────────────────────────────────────
    const { data: selfHit } = await sb
      .from('phone_numbers')
      .select('number, label')
      .eq('number', to)
      .eq('active', true)
      .maybeSingle()
    if (selfHit) {
      return new Response(JSON.stringify({
        error: 'recipient_is_our_own_number',
        details: `Cannot text our own sender line (${selfHit.label || to}). Check the thread's destination phone.`,
      }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    // ────────────────────────────────────────────────────────────────────
    // Refuse-list checks. Two gates, both keyed on the recipient phone:
    //   1. DND          — contacts.do_not_text=true (manual flag or STOP)
    //   2. Phone status — contacts.phone_status IN ('wrong_number','disconnected')
    //                     set by the post-call disposition modal (issue #244)
    // Either gate returns 403 + structured error so the caller (UI /
    // cadence engine) can mark the queue row 'cancelled' with a reason.
    // ────────────────────────────────────────────────────────────────────
    const bareTo = to.replace(/^\+1/, '')
    const { data: contactRows } = await sb
      .from('contacts')
      .select('id, phone, do_not_text, dnd_reason, phone_status')
      .or(`phone.eq.${to},phone.eq.${bareTo}`)
      .limit(5)

    const dndHit = (contactRows || []).find((c: any) => c.do_not_text === true)
    if (dndHit) {
      return new Response(JSON.stringify({
        error: 'recipient_on_dnd',
        details: dndHit.dnd_reason || 'do_not_text=true',
        contact_id: dndHit.id,
      }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const badPhoneHit = (contactRows || []).find(
      (c: any) => c.phone_status === 'wrong_number' || c.phone_status === 'disconnected'
    )
    if (badPhoneHit) {
      return new Response(JSON.stringify({
        error: 'bad_phone_status',
        details: `phone_status=${badPhoneHit.phone_status}`,
        contact_id: badPhoneHit.id,
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

    // Don't pre-split. Two reasons:
    //   * mac_bridge / iMessage has no length limit (Nathan 2026-05-27 — #235).
    //   * Twilio's REST API handles concatenated-SMS automatically when you
    //     hand it ONE body up to 1,600 chars — the recipient's phone reassembles
    //     the segments into one threaded message. When we pre-split and send N
    //     separate Twilio API calls, the recipient sees N separate texts (same
    //     UX bug as the iMessage path had). Per Nathan 2026-05-28: he hit this
    //     after PR #211 made Twilio the default outbound gateway.
    // splitAtPunctuation() is kept available above in case a future call path
    // needs explicit segmentation, but the main send flow no longer uses it.
    const segments = [(body || '').trim()]
    const isSplit  = segments.length > 1
    const channel  = gateway === 'mac_bridge' ? 'imessage' : 'sms'
    const threadKey = deal_id
      ? (contact_id ? `${deal_id}:contact:${contact_id}` : `${deal_id}:phone:${to}`)
      : null

    // Insert a messages_outbound row for each segment
    const initialStatus = gateway === 'mac_bridge' ? 'pending_mac' : 'queued'
    const insertedIds: string[] = []

    for (let segIdx = 0; segIdx < segments.length; segIdx++) {
      const segment = segments[segIdx]
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
          // Only attach media_url to the first segment
          ...(media_url && segIdx === 0 ? { media_url } : {}),
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
    // StatusCallback URL — Twilio hits this as the message moves through
    // queued → sent → delivered/undelivered/failed. Without it, our row
    // stays at 'sent' forever and we can't tell delivery from acceptance.
    // Per CLAUDE.md → "Action confirmation — close the loop." Wired
    // 2026-05-07. The handler (`twilio-sms-status` Edge Function) verifies
    // the X-Twilio-Signature so forged callbacks can't lie about delivery.
    const statusCallbackUrl = `${supabaseUrl}/functions/v1/twilio-sms-status`
    let lastStatus = 'sent'
    let lastErrorCode: string | null = null
    let lastErrorMessage: string | null = null

    for (let i = 0; i < segments.length; i++) {
      const twilioRes = await fetch(twilioUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${btoa(`${twilioAccountSid}:${twilioAuthToken}`)}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
            To: to,
            From: resolvedFrom,
            Body: segments[i] || '',
            StatusCallback: statusCallbackUrl,
            ...(media_url && i === 0 ? { MediaUrl: media_url } : {}),
          }).toString(),
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
      if (!twilioRes.ok) {
        lastStatus = 'failed'
        lastErrorCode = String(twilioData.code ?? '')
        lastErrorMessage = twilioData.message ?? 'Unknown Twilio error'
      }
    }

    // Bug 1 fix (2026-06-05): surface Twilio failure as HTTP 502 so the
    // mobile/web UI's `if (!res.ok)` catch path fires and shows the real
    // error instead of fake "Sent". Row is already marked status='failed'
    // above so the Comms history reflects reality. Successful sends still
    // return 200 with status='sent'.
    const httpStatus = lastStatus === 'failed' ? 502 : 200
    return new Response(
      JSON.stringify({
        id: insertedIds[0],
        ids: insertedIds,
        parts: segments.length,
        status: lastStatus,
        ...(lastStatus === 'failed' ? {
          error: 'twilio_rejected',
          error_code: lastErrorCode,
          details: lastErrorMessage,
        } : {}),
      }),
      { status: httpStatus, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
