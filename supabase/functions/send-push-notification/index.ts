// send-push-notification — fires Expo Push Service deliveries.
//
// Called by Postgres triggers (inbound SMS, team chat, etc.) via
// net.http_post. Looks up `expo_push_token` on profiles for the target
// users and POSTs the bundled payload to https://exp.host/--/api/v2/push/send.
//
// Body:
//   {
//     user_ids?: string[],     // target multiple users (admin broadcast)
//     user_id?: string,        // OR a single user
//     title: string,
//     body: string,
//     data?: Record<string, unknown>,  // routing payload (type, thread_key, etc.)
//     sound?: 'default' | null,
//     badge?: number,
//   }
//
// Deploys with verify_jwt=false because Postgres triggers don't carry
// JWTs. Trust comes from the requirement that callers be on the same
// network (pg_net is internal), and the only thing this function can do
// is send a push — no DB writes, no PII exfiltration.

import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
}

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'

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

  let body: {
    user_ids?: string[]
    user_id?: string
    title?: string
    body?: string
    data?: Record<string, unknown>
    sound?: 'default' | null
    badge?: number
  }
  try {
    body = await req.json()
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400)
  }

  const title = (body.title ?? '').trim()
  const message = (body.body ?? '').trim()
  if (!title && !message) {
    return jsonResponse({ error: 'title or body required' }, 400)
  }

  const ids = body.user_ids ?? (body.user_id ? [body.user_id] : [])
  if (ids.length === 0) {
    return jsonResponse({ error: 'no recipients' }, 400)
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const sb = createClient(supabaseUrl, serviceKey)

  const { data: rows, error } = await sb
    .from('profiles')
    .select('id, expo_push_token')
    .in('id', ids)
  if (error) {
    return jsonResponse({ error: error.message }, 500)
  }

  const tokens = (rows ?? [])
    .map((r) => (r.expo_push_token as string | null) ?? '')
    .filter((t): t is string => t.length > 0)
  if (tokens.length === 0) {
    // Not an error — just nobody has registered for push yet.
    return jsonResponse({ ok: true, delivered: 0, reason: 'no_tokens' })
  }

  // Expo accepts an array of message objects in one POST. Each gets its
  // own delivery receipt downstream.
  const messages = tokens.map((to) => ({
    to,
    title: title || 'DCC',
    body: message,
    sound: body.sound === null ? undefined : 'default',
    data: body.data ?? {},
    ...(body.badge !== undefined ? { badge: body.badge } : {}),
  }))

  let pushRes: Response
  try {
    pushRes = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(messages),
    })
  } catch (e) {
    return jsonResponse(
      {
        error: 'expo_unreachable',
        message: e instanceof Error ? e.message : 'fetch failed',
      },
      502,
    )
  }

  const pushBody = await pushRes.json().catch(() => ({}))
  if (!pushRes.ok) {
    return jsonResponse(
      { error: 'expo_error', status: pushRes.status, body: pushBody },
      502,
    )
  }

  // Expo's response is { data: [{ status: 'ok' | 'error', id?, message? }, ...] }
  const tickets = (pushBody?.data ?? []) as Array<{
    status: string
    message?: string
  }>
  const okCount = tickets.filter((t) => t.status === 'ok').length

  // Clean up dead tokens — if Expo says DeviceNotRegistered, clear the
  // column so the next push isn't wasted on it.
  const deadIndices = tickets
    .map((t, i) => (t.status === 'error' && /DeviceNotRegistered/i.test(t.message ?? '') ? i : -1))
    .filter((i) => i >= 0)
  if (deadIndices.length > 0) {
    const deadTokens = deadIndices.map((i) => tokens[i])
    await sb
      .from('profiles')
      .update({ expo_push_token: null })
      .in('expo_push_token', deadTokens)
  }

  return jsonResponse({
    ok: true,
    delivered: okCount,
    failed: tickets.length - okCount,
    dead_tokens_cleared: deadIndices.length,
  })
})
