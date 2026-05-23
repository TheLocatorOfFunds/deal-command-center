// vapi-webhook — receives Vapi server events for our voice agent.
//
// ── Contract (verified via docs.vapi.ai 2026-05-23; some fields partial) ──
//
// Vapi sends multiple event types to the same Server URL. Discriminate
// by `message.type`. We only act on `end-of-call-report` for now —
// everything else is acknowledged with a 200 so Vapi doesn't retry.
//
// Auth: legacy shared-secret model. Vapi adds `x-vapi-secret: <SECRET>`
// to every webhook delivery. We compare against VAPI_WEBHOOK_SECRET.
// Newer HMAC-signing exists but the header name is configurable per
// Server URL — start with the shared secret, swap to HMAC later if we
// want stricter replay protection.
//
// Payload fields we use (from docs.vapi.ai/server-url/events):
//   message.type                       — 'end-of-call-report'
//   message.call.id                    — Vapi call ID (used for dedupe)
//   message.call.customer.number       — caller's phone (E.164) — match to our deal/contact
//   message.call.startedAt / endedAt   — timestamps
//   message.call.cost                  — total $ cost
//   message.call.recordingUrl          — MP3 URL (Vapi-hosted)
//   message.transcript                 — full transcript text
//   message.summary                    — provider-generated summary
//   message.analysis.structuredData    — JSON-Schema-extracted intake fields
//
// Field paths above are best-effort from doc snippets — Vapi's
// ServerMessage TypeScript type wasn't fully retrievable during the
// spike. The function tolerates shape drift by checking multiple
// candidate paths before bailing.
//
// Deploy with verify_jwt=false — Vapi has no Supabase JWT.

import { createClient } from 'jsr:@supabase/supabase-js@2'

type ServerMessage = {
  type?: string
  call?: {
    id?: string
    customer?: { number?: string }
    startedAt?: string
    endedAt?: string
    cost?: number
    recordingUrl?: string
  }
  transcript?: string
  summary?: string
  analysis?: {
    summary?: string
    structuredData?: Record<string, unknown>
  }
  // Some Vapi event shapes nest the call analysis directly on the message
  // — defensive parsing handles both.
  structuredData?: Record<string, unknown>
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-vapi-secret',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function normalizePhone(p: string | undefined | null): string | null {
  if (!p) return null
  const digits = p.replace(/\D/g, '')
  if (!digits) return null
  if (digits.length === 10) return '+1' + digits
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits
  return p.startsWith('+') ? p : '+' + digits
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'POST only' }, 405)
  }

  // ── Auth ────────────────────────────────────────────────────────────
  const expectedSecret = Deno.env.get('VAPI_WEBHOOK_SECRET') ?? ''
  const presentedSecret = req.headers.get('x-vapi-secret') ?? ''
  if (!expectedSecret) {
    console.error('vapi-webhook: VAPI_WEBHOOK_SECRET not configured')
    return jsonResponse({ error: 'not_configured' }, 500)
  }
  if (presentedSecret !== expectedSecret) {
    console.warn('vapi-webhook: bad secret', {
      presented_len: presentedSecret.length,
    })
    return jsonResponse({ error: 'unauthorized' }, 401)
  }

  // ── Parse ───────────────────────────────────────────────────────────
  let body: { message?: ServerMessage }
  try {
    body = await req.json()
  } catch {
    return jsonResponse({ error: 'invalid_json' }, 400)
  }
  const msg = body.message ?? {}

  // We only handle end-of-call-report. Other event types
  // (status-update, transcript, function-call, etc.) get a 200 so Vapi
  // doesn't retry.
  if (msg.type !== 'end-of-call-report') {
    return jsonResponse({ ok: true, skipped: msg.type ?? 'unknown' })
  }

  // ── Extract ─────────────────────────────────────────────────────────
  const vapiCallId = msg.call?.id ?? null
  const callerPhone = normalizePhone(msg.call?.customer?.number)
  const transcript = msg.transcript ?? null
  const summary = msg.summary ?? msg.analysis?.summary ?? null
  const structuredData =
    msg.analysis?.structuredData ?? msg.structuredData ?? null
  const recordingUrl = msg.call?.recordingUrl ?? null
  const endedAt = msg.call?.endedAt ?? null
  const costDollars = typeof msg.call?.cost === 'number' ? msg.call.cost : null
  const costCents = costDollars != null ? Math.round(costDollars * 100) : null

  if (!vapiCallId) {
    console.error('vapi-webhook: missing message.call.id', { msg })
    return jsonResponse({ error: 'missing_call_id' }, 400)
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const db = createClient(supabaseUrl, serviceKey)

  // ── Find or attach to a call_logs row ───────────────────────────────
  //
  // If we already stored this Vapi call ID, we're idempotent — UPDATE
  // the existing row. Otherwise we look up the most recent inbound call
  // from this phone number within the last hour and attach the intake
  // there (the Twilio call_logs row was created when the call rang the
  // line). If nothing matches, we insert a fresh row keyed by phone.
  let callLogId: string | null = null
  {
    const { data: existing } = await db
      .from('call_logs')
      .select('id')
      .eq('voice_call_id', vapiCallId)
      .maybeSingle()
    if (existing) callLogId = existing.id as string
  }

  if (!callLogId && callerPhone) {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const { data: candidate } = await db
      .from('call_logs')
      .select('id')
      .eq('direction', 'inbound')
      .eq('from_number', callerPhone)
      .gte('created_at', oneHourAgo)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (candidate) callLogId = candidate.id as string
  }

  // ── Resolve deal_id / contact_id by caller phone ────────────────────
  let dealId: string | null = null
  let contactId: string | null = null
  if (callerPhone) {
    const { data: contact } = await db
      .from('contacts')
      .select('id')
      .or(
        `phone.eq.${callerPhone},phone.eq.${callerPhone.replace(/^\+1/, '')}`,
      )
      .limit(1)
      .maybeSingle()
    if (contact) {
      contactId = contact.id as string
      const { data: link } = await db
        .from('contact_deals')
        .select('deal_id')
        .eq('contact_id', contactId)
        .limit(1)
        .maybeSingle()
      if (link) dealId = link.deal_id as string
    }
  }

  const intakePayload = {
    voice_provider: 'vapi',
    voice_call_id: vapiCallId,
    voice_transcript: transcript,
    voice_summary: summary,
    voice_intake: structuredData,
    voice_cost_cents: costCents,
    recording_url: recordingUrl ?? undefined,
    ended_at: endedAt ?? undefined,
  } as Record<string, unknown>
  // Strip undefined so we don't blank out columns
  for (const k of Object.keys(intakePayload)) {
    if (intakePayload[k] === undefined) delete intakePayload[k]
  }

  if (callLogId) {
    const { error: upErr } = await db
      .from('call_logs')
      .update(intakePayload)
      .eq('id', callLogId)
    if (upErr) {
      console.error('vapi-webhook: UPDATE failed', upErr)
      return jsonResponse({ error: 'db_update_failed', details: upErr.message }, 500)
    }
  } else {
    // No prior row — insert one. status='completed' so the
    // missed-voicemail trigger doesn't fire on this row.
    const { data: ins, error: insErr } = await db
      .from('call_logs')
      .insert({
        direction: 'inbound',
        from_number: callerPhone ?? 'unknown',
        to_number: 'agent',
        status: 'completed',
        deal_id: dealId,
        contact_id: contactId,
        started_at: msg.call?.startedAt ?? null,
        ...intakePayload,
      })
      .select('id')
      .single()
    if (insErr) {
      console.error('vapi-webhook: INSERT failed', insErr)
      return jsonResponse({ error: 'db_insert_failed', details: insErr.message }, 500)
    }
    callLogId = ins.id as string
  }

  // Backfill deal_id / contact_id if we resolved them and the row
  // doesn't already have them. Some Twilio inserts can't resolve the
  // deal at ring time but we can now.
  if (callLogId && (dealId || contactId)) {
    await db
      .from('call_logs')
      .update({
        deal_id: dealId ?? undefined,
        contact_id: contactId ?? undefined,
      })
      .eq('id', callLogId)
      .is('deal_id', null)
  }

  // Activity feed entry for the deal — so the intake shows up in the
  // existing deal screen / mobile deal screen activity timeline
  // without any new UI.
  if (dealId) {
    const intakeSummary = summary ?? 'Agent intake completed (no summary).'
    await db.from('activity').insert({
      deal_id: dealId,
      user_id: null,
      action: '🤖 Voice agent intake: ' + intakeSummary.slice(0, 240),
    })
  } else if (callerPhone) {
    // No deal matched → drop a lead row so the caller doesn't fall
    // through the floor. Nathan/Justin can convert it manually.
    await db.from('leads').insert({
      name: (structuredData?.caller_name as string) ?? 'Unknown caller',
      email: null,
      status: 'new',
      metadata: {
        source: 'vapi-agent-intake',
        from_number: callerPhone,
        intake: structuredData,
        summary,
        vapi_call_id: vapiCallId,
      },
    })
  }

  return jsonResponse({
    ok: true,
    call_log_id: callLogId,
    matched_deal: dealId,
    matched_contact: contactId,
  })
})
