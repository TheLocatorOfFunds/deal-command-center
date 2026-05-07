import { createClient } from 'jsr:@supabase/supabase-js@2'

/**
 * resend-webhook — Resend delivery + engagement webhook.
 *
 * Resend sends signed webhook events for every email lifecycle change.
 * Without this hook our `emails.status` was forever stuck at 'sent'
 * (which only meant "Resend accepted the request"); bounces, spam
 * complaints, and delayed delivery were invisible to the team.
 *
 * Per CLAUDE.md → "Action confirmation — close the loop on every external
 * side effect" — every action that talks to a provider with delivery
 * callbacks gets the callback wired on the same PR. Set 2026-05-07 by
 * Justin during the RVM testing.
 *
 * Events handled:
 *   email.sent              → status='sent'                (initial — usually skipped here, set by send-email at insert time)
 *   email.delivered         → status='delivered'           (provider accepted by recipient)
 *   email.delivery_delayed  → status='delivery_delayed'    (transient — will retry)
 *   email.bounced           → status='bounced'             + error_message=<bounce details>
 *   email.complained        → status='complained'          + error_message='Recipient marked as spam'
 *   email.failed            → status='failed'              + error_message=<reason>
 *   email.opened            → (event log only — engagement, separate from delivery)
 *   email.clicked           → (event log only)
 *
 * For now we only update the canonical `status` + `error_message`. Engagement
 * (opened/clicked) signals are logged in console but not persisted to a
 * dedicated email_events table yet — that's a future polish.
 *
 * Auth: Resend uses Svix (svix.com) for webhook signing.
 *   Headers: svix-id, svix-timestamp, svix-signature
 *   Sign basis: `${id}.${timestamp}.${rawBody}`
 *   Algorithm: HMAC-SHA256 with the secret BYTES (whsec_-prefixed, base64-encoded)
 *   Compare: 'v1,<base64-sig>' against any of the space-separated signatures
 *
 * Dashboard config (one-time, by Nathan or Justin):
 *   1. Resend dashboard → Webhooks → Add endpoint
 *   2. Endpoint URL:
 *      https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/resend-webhook
 *   3. Events: select all email.* events
 *   4. Copy the signing secret (starts with whsec_)
 *   5. Set as Edge Function secret:
 *      supabase secrets set RESEND_WEBHOOK_SECRET=whsec_xxxxx \
 *        --project-ref rcfaashkfpurkvtmsmeb
 *
 * Edge Function secrets:
 *   - SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (auto)
 *   - RESEND_WEBHOOK_SECRET (the whsec_ value from the dashboard)
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

/** Verify Svix signature on a Resend webhook.
 *  Returns true if any of the `v1` signatures in the header matches.
 *  Tolerance: 5 minutes — rejects replays older than that.
 */
async function verifySvixSignature(args: {
  secret: string,         // whsec_xxxxx (full, including prefix)
  svixId: string,
  svixTimestamp: string,  // unix seconds, string
  svixSignature: string,  // "v1,base64sig v2,otherbase64sig" — space-separated
  rawBody: string,
}): Promise<boolean> {
  // Reject anything claiming a timestamp older than 5 minutes (replay protection).
  const ts = parseInt(args.svixTimestamp, 10)
  if (isNaN(ts)) return false
  const ageSec = Math.abs(Math.floor(Date.now() / 1000) - ts)
  if (ageSec > 5 * 60) return false

  // Strip whsec_ prefix and base64-decode the secret.
  const secretRaw = args.secret.startsWith('whsec_') ? args.secret.slice(6) : args.secret
  let secretBytes: Uint8Array
  try {
    const bin = atob(secretRaw)
    secretBytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) secretBytes[i] = bin.charCodeAt(i)
  } catch {
    console.error('RESEND_WEBHOOK_SECRET is not valid base64')
    return false
  }

  const signedPayload = `${args.svixId}.${args.svixTimestamp}.${args.rawBody}`
  const key = await crypto.subtle.importKey(
    'raw',
    secretBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sigBytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload))
  const expected = btoa(String.fromCharCode(...new Uint8Array(sigBytes)))

  // Header may carry multiple version,sig pairs separated by spaces.
  // Match any of the v1 entries in constant-ish time.
  for (const entry of args.svixSignature.split(' ')) {
    const [version, sig] = entry.split(',')
    if (version !== 'v1' || !sig) continue
    if (sig.length === expected.length) {
      let same = true
      for (let i = 0; i < sig.length; i++) {
        if (sig.charCodeAt(i) !== expected.charCodeAt(i)) same = false
      }
      if (same) return true
    }
  }
  return false
}

interface ResendWebhookEnvelope {
  type: string                   // 'email.delivered', 'email.bounced', etc.
  created_at: string
  data: {
    email_id?: string            // the id we stored as resend_id
    id?: string                  // sometimes nested differently
    to?: string[]
    from?: string
    subject?: string
    bounce?: {
      type?: string              // 'hard' | 'soft' | 'undetermined'
      message?: string
    }
    reason?: string              // for failed events
    [key: string]: unknown
  }
}

function classifyEvent(envelope: ResendWebhookEnvelope): {
  status: string,
  errorMessage: string | null,
  isEngagementOnly: boolean,
} {
  const t = envelope.type
  const data = envelope.data || {}

  if (t === 'email.delivered') {
    return { status: 'delivered', errorMessage: null, isEngagementOnly: false }
  }
  if (t === 'email.delivery_delayed') {
    return { status: 'delivery_delayed', errorMessage: 'Delivery delayed (transient — Resend will retry)', isEngagementOnly: false }
  }
  if (t === 'email.bounced') {
    const bounceType = data.bounce?.type || 'unknown'
    const bounceMsg = data.bounce?.message || '(no bounce message provided)'
    return {
      status: 'bounced',
      errorMessage: `Bounced (${bounceType}): ${bounceMsg}`,
      isEngagementOnly: false,
    }
  }
  if (t === 'email.complained') {
    return {
      status: 'complained',
      errorMessage: 'Recipient marked this as spam — do not email this address again',
      isEngagementOnly: false,
    }
  }
  if (t === 'email.failed') {
    const reason = data.reason || '(no reason provided)'
    return { status: 'failed', errorMessage: `Resend reported failure: ${reason}`, isEngagementOnly: false }
  }
  if (t === 'email.sent') {
    // Send-email already inserts with status='sent'. This event just confirms
    // Resend accepted the handoff — no transition needed for our table.
    return { status: 'sent', errorMessage: null, isEngagementOnly: false }
  }
  // Engagement events — log but don't change delivery status (a delivered
  // email that's later opened is still 'delivered').
  if (t === 'email.opened' || t === 'email.clicked') {
    return { status: '', errorMessage: null, isEngagementOnly: true }
  }
  return { status: '', errorMessage: null, isEngagementOnly: false }
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
  const webhookSecret = Deno.env.get('RESEND_WEBHOOK_SECRET')

  // Refuse to operate without a verifying secret. Better to drop legitimate
  // events than accept forged ones that could lie about delivery state.
  if (!webhookSecret) {
    console.error('RESEND_WEBHOOK_SECRET not configured — refusing webhook')
    return new Response(JSON.stringify({ error: 'webhook handler not configured' }), {
      status: 503,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  // Read the raw body once — we need the unparsed text for the signature
  // calculation, then parse JSON afterward.
  const rawBody = await req.text()

  const svixId = req.headers.get('svix-id') || ''
  const svixTs = req.headers.get('svix-timestamp') || ''
  const svixSig = req.headers.get('svix-signature') || ''

  if (!svixId || !svixTs || !svixSig) {
    return new Response(JSON.stringify({ error: 'missing svix-* headers' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const valid = await verifySvixSignature({
    secret: webhookSecret,
    svixId, svixTimestamp: svixTs, svixSignature: svixSig, rawBody,
  })
  if (!valid) {
    console.warn(`webhook signature mismatch (id=${svixId}, ts=${svixTs})`)
    return new Response(JSON.stringify({ error: 'invalid signature' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  let envelope: ResendWebhookEnvelope
  try {
    envelope = JSON.parse(rawBody)
  } catch {
    return new Response(JSON.stringify({ error: 'invalid JSON body' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const emailId = envelope.data?.email_id || envelope.data?.id
  if (!emailId) {
    console.warn('webhook event missing email_id/id', envelope)
    // Return 200 anyway so Resend doesn't keep retrying.
    return new Response(JSON.stringify({ ok: true, matched: false, note: 'no email_id in payload' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const sb = createClient(supabaseUrl, serviceRoleKey)

  // Look up the row by resend_id (which we stored when we got Resend's
  // accept response in send-email).
  const { data: rows, error: lookupErr } = await sb
    .from('emails')
    .select('id, status, deal_id')
    .eq('resend_id', emailId)
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
    console.warn(`No matching emails row for resend_id=${emailId} (event=${envelope.type})`)
    return new Response(JSON.stringify({ ok: true, matched: false, resend_id: emailId, event: envelope.type }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const row = rows[0]
  const { status: newStatus, errorMessage, isEngagementOnly } = classifyEvent(envelope)

  if (isEngagementOnly) {
    // Don't overwrite delivery status with an engagement event. Just log
    // for now — future polish: write to a dedicated email_events table
    // for engagement timeline.
    console.log(`engagement event (no status change): row=${row.id} event=${envelope.type}`)
    return new Response(JSON.stringify({ ok: true, matched: true, event: envelope.type, engagement_only: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  if (!newStatus) {
    console.log(`unmapped event type=${envelope.type} — skipping status update`)
    return new Response(JSON.stringify({ ok: true, matched: true, event: envelope.type, note: 'unmapped' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  // Don't downgrade a terminal status. Once an email is bounced or
  // complained, it should stay that way even if a stale 'delivered' event
  // arrives out of order.
  const TERMINAL_BAD = new Set(['bounced', 'complained', 'failed'])
  if (TERMINAL_BAD.has(row.status) && newStatus === 'delivered') {
    console.log(`refusing to downgrade ${row.status}→delivered for row ${row.id}`)
    return new Response(JSON.stringify({ ok: true, matched: true, ignored: true, reason: 'terminal_status' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const { error: updateErr } = await sb
    .from('emails')
    .update({
      status: newStatus,
      error_message: errorMessage,
    })
    .eq('id', row.id)

  if (updateErr) {
    console.error('update error:', updateErr.message)
    return new Response(JSON.stringify({ error: 'update failed' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  console.log(`webhook applied: row=${row.id} ${row.status}→${newStatus} event=${envelope.type}`)

  return new Response(JSON.stringify({
    ok: true,
    matched: true,
    email_id: row.id,
    new_status: newStatus,
    event: envelope.type,
  }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
})
