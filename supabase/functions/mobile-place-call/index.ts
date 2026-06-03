// mobile-place-call — Twilio 2-leg "click to call" bridge for the mobile app.
//
// Why this exists: Expo Go can't load the Twilio Voice SDK (no native code
// allowed in Expo Go). Without the SDK, `tel:5135551234` on the phone just
// opens the native dialer, which places the call from the user's cellular
// SIM — so the destination sees the user's personal cell as caller ID, not
// the Twilio business number.
//
// This function fixes the caller-ID problem by routing through Twilio:
//   1. App calls this function with { to_number, deal_id?, contact_id? }
//   2. We look up the caller's cell in `profiles.phone`
//   3. We POST to Twilio's Calls API: From=business, To=user's cell, plus
//      inline TwiML that <Dial>s the destination using the business number
//      as caller ID
//   4. Twilio rings the user's cell. They answer. Twilio bridges them to
//      the destination. Destination sees the business number.
//
// One ugly truth: the user has to answer their own ringing phone. That's
// the cost of doing this in Expo Go. Phase 2 (EAS dev build) replaces this
// with the Twilio Voice SDK — the call connects natively in-app, no
// callback step.
//
// Deploy with verify_jwt=true. Caller must be authenticated.

import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
}

const BUSINESS_NUMBER = '+15139985440' // FundLocators / Cincinnati Twilio main
const PROJECT_REF = 'rcfaashkfpurkvtmsmeb'
const STATUS_CB_URL = `https://${PROJECT_REF}.supabase.co/functions/v1/twilio-voice-status`

function normalizePhone(p: string | null | undefined): string {
  if (!p) return ''
  const digits = p.replace(/\D/g, '')
  if (!digits) return ''
  if (digits.length === 10) return '+1' + digits
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits
  return p.startsWith('+') ? p : '+' + digits
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'POST only' }, 405)
  }

  // ── Auth (same JWT-decode pattern as send-sms) ─────────────────────────
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) {
    return jsonResponse({ error: 'Missing authorization' }, 401)
  }
  let userId: string
  try {
    const token = authHeader.replace('Bearer ', '')
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    const payload = JSON.parse(atob(b64))
    userId = payload.sub
    if (!userId) throw new Error('no sub')
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401)
  }

  // ── Env ───────────────────────────────────────────────────────────────
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const accountSid = Deno.env.get('TWILIO_ACCOUNT_SID')!
  const authToken = Deno.env.get('TWILIO_AUTH_TOKEN')!
  const sb = createClient(supabaseUrl, serviceKey)

  // ── Body ──────────────────────────────────────────────────────────────
  let body: {
    to_number?: string
    deal_id?: string | null
    contact_id?: string | null
  }
  try {
    body = await req.json()
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400)
  }
  const toNumber = normalizePhone(body.to_number)
  if (!toNumber) {
    return jsonResponse({ error: 'Missing to_number' }, 400)
  }

  // ── Look up caller's cell ─────────────────────────────────────────────
  const { data: profile, error: profErr } = await sb
    .from('profiles')
    .select('id, name, phone')
    .eq('id', userId)
    .maybeSingle()
  if (profErr) {
    return jsonResponse({ error: profErr.message }, 500)
  }
  const userCell = normalizePhone(profile?.phone)
  if (!userCell) {
    return jsonResponse(
      {
        error: 'cell_phone_required',
        message:
          'Your cell phone number is not set on your profile. Add it under Settings, then try again.',
      },
      400,
    )
  }

  // ── DND check on the destination ──────────────────────────────────────
  const bareTo = toNumber.replace(/^\+1/, '')
  const { data: dndRows } = await sb
    .from('contacts')
    .select('id, phone, do_not_call, dnd_reason')
    .or(`phone.eq.${toNumber},phone.eq.${bareTo}`)
    .eq('do_not_call', true)
    .limit(1)
  if (dndRows && dndRows.length > 0) {
    return jsonResponse(
      {
        error: 'recipient_on_dnd',
        details: dndRows[0].dnd_reason || 'do_not_call=true',
        contact_id: dndRows[0].id,
      },
      403,
    )
  }

  // ── Build inline TwiML for the bridge ─────────────────────────────────
  // When Twilio calls the user's cell and they pick up, this TwiML runs
  // and Dials the destination from the business number. The destination
  // sees the business number as caller ID. Recording on, dual-channel so
  // the team can review either side later.
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial callerId="${BUSINESS_NUMBER}" timeout="30" record="record-from-answer-dual" recordingStatusCallback="${STATUS_CB_URL}" recordingStatusCallbackMethod="POST">
    <Number statusCallback="${STATUS_CB_URL}" statusCallbackMethod="POST">${toNumber}</Number>
  </Dial>
</Response>`

  // ── Place the bridge call via Twilio ──────────────────────────────────
  const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`
  const twilioRes = await fetch(twilioUrl, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${accountSid}:${authToken}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      From: BUSINESS_NUMBER,
      To: userCell,
      Twiml: twiml,
      StatusCallback: STATUS_CB_URL,
      StatusCallbackMethod: 'POST',
      // Tell Twilio what events to push to StatusCallback — without these
      // the row stays at "queued" and we can't tell connected from no-answer.
      StatusCallbackEvent: 'initiated ringing answered completed',
    }).toString(),
  })
  const twilioData = await twilioRes.json()
  if (!twilioRes.ok) {
    return jsonResponse(
      {
        error: 'twilio_error',
        code: twilioData.code,
        message: twilioData.message ?? 'Twilio rejected the call',
      },
      502,
    )
  }
  const callSid = twilioData.sid as string

  // ── Resolve deal/contact for the log ──────────────────────────────────
  // Honor the client-supplied deal/contact first. When the app didn't pass a
  // deal (raw dial from the keypad), fall back to the shared resolver so the
  // call still lands on the right deal/contact if the number is known.
  let logDealId: string | null = body.deal_id ?? null
  let logContactId: string | null = body.contact_id ?? null
  if (!logDealId) {
    try {
      const { data: link } = await sb.rpc('resolve_call_link', { p_number: toNumber })
      const row = Array.isArray(link) ? link[0] : link
      if (row?.deal_id) {
        logDealId = row.deal_id
        // Keep the client-supplied contact (quick-call typeahead) if present.
        if (!logContactId) logContactId = row.contact_id || null
      }
    } catch {
      // Non-fatal — leave unlinked; status callback safety-net will retry.
    }
  }

  // ── Log the call (best-effort, don't fail the response) ───────────────
  const threadKey = logDealId
    ? logContactId
      ? `${logDealId}:contact:${logContactId}`
      : `${logDealId}:phone:${toNumber}`
    : null
  try {
    await sb.from('call_logs').insert({
      deal_id: logDealId,
      contact_id: logContactId,
      thread_key: threadKey,
      direction: 'outbound',
      from_number: BUSINESS_NUMBER,
      to_number: toNumber,
      status: 'ringing',
      twilio_call_sid: callSid,
      started_at: new Date().toISOString(),
    })
  } catch {
    // Logging shouldn't break the call response
  }

  return jsonResponse({
    ok: true,
    call_sid: callSid,
    user_cell: userCell,
    business_number: BUSINESS_NUMBER,
    to_number: toNumber,
    message:
      'Your phone will ring shortly. Answer it to connect to the destination.',
  })
})
