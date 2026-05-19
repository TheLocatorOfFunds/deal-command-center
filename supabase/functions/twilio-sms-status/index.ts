import { createClient } from 'jsr:@supabase/supabase-js@2'

/**
 * twilio-sms-status — Twilio SMS StatusCallback handler.
 *
 * Twilio fires StatusCallback for every SMS state change after the initial
 * request acceptance. Without this hook our messages_outbound.status was
 * forever stuck at 'sent' (which only meant "Twilio accepted the request");
 * undelivered, failed, or carrier-rejected SMS was invisible.
 *
 * Per CLAUDE.md → "Action confirmation — close the loop on every external
 * side effect." Set 2026-05-07 by Justin during the audit triggered by
 * the Slybroadcast RVM revelation.
 *
 * Statuses Twilio reports (https://www.twilio.com/docs/sms/api/message-resource):
 *   queued, accepted, sending      → intermediate, no UI change needed
 *   sent                            → handed to carrier (already what send-sms sets)
 *   delivered                       → carrier confirmed delivery
 *   undelivered                     → carrier rejected (after Twilio accepted) — bad number, blocked, opted-out, etc.
 *   failed                          → terminal failure (Twilio couldn't even hand off)
 *   read                            → recipient opened (only some carriers — informational)
 *
 * We update messages_outbound on the terminal states; intermediate states
 * are logged but don't change UI (avoids flicker).
 *
 * Auth: Twilio signs StatusCallback POSTs with X-Twilio-Signature.
 *   Algorithm: HMAC-SHA1 of (full URL + sorted concatenated POST params)
 *   Compare: base64-encoded result against the X-Twilio-Signature header
 * https://www.twilio.com/docs/usage/webhooks/webhooks-security
 *
 * Twilio also sends ErrorCode + ErrorMessage on undelivered/failed events
 * (e.g. 30005 = unknown destination, 30007 = filtered by carrier, 30008 =
 * unknown error). We surface those as error_code + error_message for the
 * audit trail.
 *
 * Edge Function secrets:
 *   - SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (auto)
 *   - TWILIO_AUTH_TOKEN (already set; reused for signature verification)
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

/** Twilio HMAC-SHA1 signature verification.
 *  Returns true if the X-Twilio-Signature header matches the expected
 *  signature for the request URL + form body.
 *  Reference: https://www.twilio.com/docs/usage/webhooks/webhooks-security
 */
async function verifyTwilioSignature(args: {
  authToken: string,
  fullUrl: string,         // exact URL Twilio called (incl. https://, query string)
  params: Record<string, string>,
  signature: string,       // X-Twilio-Signature header value
}): Promise<boolean> {
  // Concatenate URL + each param in lexicographically-sorted key+value order.
  const sortedKeys = Object.keys(args.params).sort()
  let signBase = args.fullUrl
  for (const k of sortedKeys) signBase += k + args.params[k]

  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(args.authToken),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  )
  const sigBytes = await crypto.subtle.sign('HMAC', key, enc.encode(signBase))
  const expected = btoa(String.fromCharCode(...new Uint8Array(sigBytes)))

  if (expected.length !== args.signature.length) return false
  let same = true
  for (let i = 0; i < expected.length; i++) {
    if (expected.charCodeAt(i) !== args.signature.charCodeAt(i)) same = false
  }
  return same
}

function classifyMessageStatus(s: string): {
  newStatus: string | null,   // null → don't touch existing status (intermediate state)
  isTerminal: boolean,
  description: string | null,
} {
  const v = (s || '').toLowerCase()
  switch (v) {
    case 'delivered':
      return { newStatus: 'delivered', isTerminal: true, description: null }
    case 'undelivered':
      return { newStatus: 'undelivered', isTerminal: true, description: 'Carrier did not deliver — number may be invalid, blocked, opted-out, or rejected by the carrier' }
    case 'failed':
      return { newStatus: 'failed', isTerminal: true, description: 'Twilio failed to deliver' }
    case 'read':
      // Some carriers send this; treat as bonus signal but don't downgrade
      // a 'delivered' to 'read' (delivered is the canonical success state).
      return { newStatus: null, isTerminal: false, description: null }
    case 'sent':
    case 'queued':
    case 'accepted':
    case 'sending':
      return { newStatus: null, isTerminal: false, description: null }
    default:
      return { newStatus: null, isTerminal: false, description: null }
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
  if (req.method !== 'POST') {
    return new Response('POST only', { status: 405, headers: corsHeaders })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const twilioAuthToken = Deno.env.get('TWILIO_AUTH_TOKEN')

  if (!twilioAuthToken) {
    console.error('TWILIO_AUTH_TOKEN not set — cannot verify signatures')
    return new Response(JSON.stringify({ error: 'webhook handler not configured' }), {
      status: 503,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  // Read raw body — Twilio POSTs application/x-www-form-urlencoded.
  const rawBody = await req.text()
  const params: Record<string, string> = {}
  for (const pair of rawBody.split('&')) {
    const [k, v] = pair.split('=').map(decodeURIComponent)
    if (k) params[k] = v ?? ''
  }

  // Verify signature against the exact URL Twilio used. Supabase Edge
  // Functions sit behind a proxy; the original URL Twilio hit comes from
  // the request URL which already includes the scheme + host + path.
  const signature = req.headers.get('X-Twilio-Signature') || req.headers.get('x-twilio-signature') || ''
  if (!signature) {
    return new Response(JSON.stringify({ error: 'missing X-Twilio-Signature header' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const fullUrl = req.url
  const valid = await verifyTwilioSignature({
    authToken: twilioAuthToken,
    fullUrl,
    params,
    signature,
  })
  if (!valid) {
    console.warn(`Twilio signature mismatch for url=${fullUrl} sid=${params.MessageSid}`)
    return new Response(JSON.stringify({ error: 'invalid signature' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const messageSid = params.MessageSid || params.SmsSid
  const messageStatus = params.MessageStatus || params.SmsStatus
  const errorCode = params.ErrorCode || ''
  const errorMessageRaw = params.ErrorMessage || ''

  if (!messageSid) {
    return new Response(JSON.stringify({ error: 'MessageSid required' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const { newStatus, isTerminal, description } = classifyMessageStatus(messageStatus)

  if (!newStatus) {
    // Intermediate state — log but don't update the row to avoid flicker.
    console.log(`intermediate Twilio status (no row update): sid=${messageSid} status=${messageStatus}`)
    return new Response(JSON.stringify({ ok: true, intermediate: true, status: messageStatus }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const sb = createClient(supabaseUrl, serviceRoleKey)

  const { data: rows, error: lookupErr } = await sb
    .from('messages_outbound')
    .select('id, status, deal_id, to_number')
    .eq('twilio_sid', messageSid)
    .order('created_at', { ascending: false })
    .limit(1)

  if (lookupErr) {
    console.error('lookup error:', lookupErr.message)
    return new Response(JSON.stringify({ error: 'lookup failed' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
  if (!rows || rows.length === 0) {
    console.warn(`No matching messages_outbound row for twilio_sid=${messageSid}`)
    return new Response(JSON.stringify({ ok: true, matched: false, sid: messageSid, status: messageStatus }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const row = rows[0]

  // Don't downgrade a terminal-bad status (undelivered, failed) to
  // delivered if events arrive out of order.
  const TERMINAL_BAD = new Set(['undelivered', 'failed'])
  if (TERMINAL_BAD.has(row.status) && newStatus === 'delivered') {
    console.log(`refusing to downgrade ${row.status}→delivered for row ${row.id}`)
    return new Response(JSON.stringify({ ok: true, ignored: true, reason: 'terminal_status' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  // Build human-readable error_message for failed/undelivered events.
  let finalErrorMessage: string | null = null
  if (newStatus === 'undelivered' || newStatus === 'failed') {
    const codeLabel = errorCode ? `[${errorCode}]` : ''
    const reasons = [errorMessageRaw, description].filter(Boolean).join(' — ')
    finalErrorMessage = [codeLabel, reasons].filter(Boolean).join(' ').trim() || description
  }

  const updateFields: Record<string, string | null> = { status: newStatus }
  if (newStatus !== 'delivered') {
    updateFields.error_message = finalErrorMessage
    if (errorCode) updateFields.error_code = errorCode
  } else {
    // Successful delivery clears any prior error
    updateFields.error_message = null
  }

  const { error: updateErr } = await sb
    .from('messages_outbound')
    .update(updateFields)
    .eq('id', row.id)

  if (updateErr) {
    console.error('update error:', updateErr.message)
    return new Response(JSON.stringify({ error: 'update failed' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  console.log(`Twilio SMS status applied: row=${row.id} ${row.status}→${newStatus} sid=${messageSid}`)

  return new Response(JSON.stringify({
    ok: true,
    matched: true,
    message_id: row.id,
    new_status: newStatus,
    twilio_status: messageStatus,
    is_terminal: isTerminal,
  }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
})
