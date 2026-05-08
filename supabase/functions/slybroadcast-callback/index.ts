import { createClient } from 'jsr:@supabase/supabase-js@2'

/**
 * slybroadcast-callback — Slybroadcast delivery webhook.
 *
 * Slybroadcast supports a `c_dispo_url` parameter on each drop. When the
 * delivery attempt completes (success OR failure), they hit that URL with
 * the outcome. We use it to update messages_outbound from `rvm_sent`
 * (we successfully handed it to Slybroadcast) to either `rvm_delivered`
 * (voicemail actually deposited on the recipient's phone) or
 * `rvm_undeliverable` (Slybroadcast tried but the carrier wouldn't accept
 * the deposit — e.g. "Unable to Detect Voicemail").
 *
 * Without this, our UI claimed every Slybroadcast 200 = "voicemail
 * dropped." That's misleading — Slybroadcast accepts the request optimistically
 * and only learns it failed once the actual delivery attempt happens
 * (often a minute later). Justin caught this 2026-05-07 when Nathan got
 * the rings but no voicemail.
 *
 * Auth: Slybroadcast doesn't sign callbacks. verify_jwt is disabled so
 * Supabase's gateway doesn't block the unauthenticated POST from Slybroadcast.
 * Security is handled inside the function by matching c_session against a real
 * row in messages_outbound - a forged callback without a valid session ID
 * can't match any row and does nothing.
 *
 * Slybroadcast callback format (from their docs + observed behavior):
 *   c_session — session ID we generated when calling vmb.php
 *   c_phone   — recipient phone (no country code, US format)
 *   c_dispo   — outcome string: 'delivered' | 'undelivered' | 'unable_to_detect_voicemail' | etc.
 *   (sometimes also c_call_duration, c_disposition_reason)
 *
 * Format may be GET (query params) or POST (form-encoded). We accept both.
 *
 * Edge Function secrets:
 *   - SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (auto)
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Map raw Slybroadcast disposition strings → our canonical status.
// Their docs aren't comprehensive; this is built up from observation.
function classifyDispo(dispo: string | null | undefined): { status: string; description: string } {
  const d = String(dispo || '').toLowerCase().trim()
  if (!d) return { status: 'rvm_unknown_dispo', description: '(no disposition reported)' }

  // Success indicators
  if (d.includes('delivered') && !d.includes('not')) {
    return { status: 'rvm_delivered', description: 'Voicemail delivered to recipient' }
  }
  if (d === 'success' || d === 'ok') {
    return { status: 'rvm_delivered', description: 'Voicemail delivered to recipient' }
  }

  // Common failure modes — unable to deposit
  if (d.includes('unable_to_detect_voicemail') || d.includes('unable to detect voicemail') || d.includes('no_voicemail')) {
    return {
      status: 'rvm_undeliverable',
      description: 'Slybroadcast could not detect a voicemail box on the recipient — common when the carrier blocks direct VM deposit (most major US carriers post-2022) or the recipient has not set up voicemail',
    }
  }
  if (d.includes('voicemail_full') || d.includes('mailbox_full')) {
    return { status: 'rvm_undeliverable', description: 'Recipient voicemail box is full' }
  }
  if (d.includes('invalid_number') || d.includes('disconnected')) {
    return { status: 'rvm_undeliverable', description: 'Recipient number is invalid or disconnected' }
  }
  if (d.includes('busy')) {
    return { status: 'rvm_undeliverable', description: 'Recipient line was busy' }
  }
  if (d.includes('no_answer') || d.includes('declined')) {
    return { status: 'rvm_undeliverable', description: 'Recipient did not answer; voicemail did not pick up' }
  }
  if (d.includes('failed') || d.includes('error')) {
    return { status: 'rvm_undeliverable', description: `Slybroadcast reported delivery failure: ${dispo}` }
  }

  // Unknown — log for inspection but don't claim success
  return { status: 'rvm_undeliverable', description: `Unrecognized Slybroadcast disposition: ${dispo}` }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

  const url = new URL(req.url)

  // Accept GET (query params) or POST (form-encoded or JSON). Slybroadcast's
  // c_dispo_url historically uses GET; we accept POST too for forward-compat.
  let payload: Record<string, string> = {}
  if (req.method === 'GET') {
    for (const [k, v] of url.searchParams) payload[k] = v
  } else {
    const ct = req.headers.get('content-type') || ''
    try {
      if (ct.includes('application/json')) {
        const j = await req.json()
        for (const [k, v] of Object.entries(j)) payload[k] = String(v)
      } else {
        // form-encoded
        const text = await req.text()
        for (const pair of text.split('&')) {
          const [k, v] = pair.split('=').map(decodeURIComponent)
          if (k) payload[k] = v ?? ''
        }
      }
    } catch (e) {
      console.warn('Could not parse callback body:', (e as Error).message)
    }
    // Query-string params still apply on POST too
    for (const [k, v] of url.searchParams) {
      if (!payload[k]) payload[k] = v
    }
  }

  // Log every callback payload so we can see exactly what Slybroadcast sends.
  console.log('[slybroadcast-callback] raw payload:', JSON.stringify(payload))

  const dispoRaw = payload.c_dispo || payload.dispo || payload.c_disposition || payload.status
  const phone = payload.c_phone || payload.phone

  // Try every plausible session field name. Slybroadcast's own API response
  // comes back as "session_id=NNNN\nnumber of phone=N" — the bare numeric ID
  // is what they'll echo back in the callback, under some key we need to discover.
  const session =
    payload.c_session ||
    payload.session_id ||
    payload.session ||
    payload.sessionId ||
    payload.c_session_id ||
    payload.id ||
    payload.call_id ||
    // fallback: scan all values for something that looks like a Slybroadcast numeric session
    (Object.values(payload).find(v => /^\d{8,}$/.test(String(v || ''))) as string | undefined)

  if (!session) {
    console.warn('[slybroadcast-callback] session not found in payload keys:', Object.keys(payload))
    // Return 200 so Slybroadcast stops retrying — we logged everything needed
    // to add the correct field name on the next deploy.
    return new Response(JSON.stringify({ ok: false, error: 'session_not_found', payload_keys: Object.keys(payload) }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const sb = createClient(supabaseUrl, serviceRoleKey)

  // Find the messages_outbound row by session id. We stored it as
  // `provider_sid` on the row when we got the OK response from the
  // initial drop. Slybroadcast's response actually contains the session
  // id wrapped in "session_id=XXX\nnumber of phone=YYY" — we stored the
  // whole thing, so we use a LIKE match for resilience.
  const { data: rows, error: lookupErr } = await sb
    .from('messages_outbound')
    .select('id, status, deal_id, to_number, error_message')
    .eq('channel', 'rvm')
    .like('provider_sid', `%${session}%`)
    .order('updated_at', { ascending: false })
    .limit(1)

  if (lookupErr) {
    console.error('lookup error:', lookupErr.message)
    return new Response(JSON.stringify({ error: 'lookup failed' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
  if (!rows || rows.length === 0) {
    console.warn(`No matching messages_outbound row for session ${session}`)
    // Return 200 anyway so Slybroadcast doesn't keep retrying — there's
    // nothing actionable to do if the row was deleted.
    return new Response(JSON.stringify({ ok: true, matched: false, session }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const row = rows[0]
  const { status: newStatus, description } = classifyDispo(dispoRaw)

  // Build a structured note that captures the raw payload for debugging.
  // We intentionally don't overwrite a prior failure note with a generic
  // success message — but for new rows (current status='rvm_sent') we
  // always update.
  const errorMessage = newStatus === 'rvm_delivered' ? null : description

  const { error: updateErr } = await sb
    .from('messages_outbound')
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

  console.log(`callback applied: row=${row.id} status=${newStatus} dispo=${dispoRaw} session=${session}`)

  return new Response(JSON.stringify({
    ok: true,
    matched: true,
    message_id: row.id,
    new_status: newStatus,
    dispo_raw: dispoRaw,
    description,
  }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
})
