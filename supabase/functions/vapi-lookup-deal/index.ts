// vapi-lookup-deal — Vapi custom tool, called by the voice agent mid-call.
//
// What it does: takes the caller's phone number, returns a short string
// like "Randy Amos · Hamilton County case 24CV1234 · status: claim-filed"
// so the agent can personalize the call:
//
//   Caller: "Hi, I'm Randy Amos calling about my case."
//   Agent: "Hi Randy — I can see your Hamilton County case 24CV1234. Calling
//          about the same one?"
//
// Without this, the agent has to ask cold every time. With this, it
// sounds like we know who's calling.
//
// ── Vapi tool contract (verified 2026-05-23) ────────────────────────────
// Request: ServerMessageToolCalls — message.toolCalls[] with each entry
// containing toolCallId + the LLM function arguments.
// Response shape Vapi expects:
//   { results: [{ toolCallId: "...", result: "single-line summary" }] }
// `result` MUST be a single line — line breaks cause parse errors.
// Return HTTP 200 even on per-tool failures (use { error } per result).
//
// Auth: same x-vapi-secret shared secret as vapi-webhook.
//
// Deploy with verify_jwt=false.

import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-vapi-secret',
}

type ToolCall = {
  id?: string
  toolCallId?: string
  function?: {
    name?: string
    arguments?: string | Record<string, unknown>
  }
  // Some Vapi event shapes flatten arguments directly. Defensive read.
  arguments?: string | Record<string, unknown>
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

function parseArgs(
  call: ToolCall,
): Record<string, unknown> | null {
  const raw = call.function?.arguments ?? call.arguments
  if (!raw) return null
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as Record<string, unknown>
    } catch {
      return null
    }
  }
  return raw
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
  if (!expectedSecret) return jsonResponse({ error: 'not_configured' }, 500)
  if (presentedSecret !== expectedSecret) {
    return jsonResponse({ error: 'unauthorized' }, 401)
  }

  // ── Parse the tool-call envelope ────────────────────────────────────
  let body: { message?: { toolCalls?: ToolCall[] } }
  try {
    body = await req.json()
  } catch {
    return jsonResponse({ error: 'invalid_json' }, 400)
  }

  const toolCalls = body.message?.toolCalls ?? []
  if (toolCalls.length === 0) {
    return jsonResponse({ results: [] })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const db = createClient(supabaseUrl, serviceKey)

  // ── Execute each tool call ──────────────────────────────────────────
  const results: Array<{
    toolCallId: string
    result?: string
    error?: string
  }> = []

  for (const call of toolCalls) {
    const toolCallId = call.toolCallId ?? call.id ?? ''
    const args = parseArgs(call) ?? {}
    const phone = normalizePhone(
      (args.phone_number ?? args.phone ?? args.from_number) as string,
    )

    if (!phone) {
      results.push({
        toolCallId,
        result: 'No phone number provided. Ask the caller for their number.',
      })
      continue
    }

    // 1. Match contact by phone (E.164 or local-style)
    const { data: contact } = await db
      .from('contacts')
      .select('id, name, company')
      .or(`phone.eq.${phone},phone.eq.${phone.replace(/^\+1/, '')}`)
      .limit(1)
      .maybeSingle()

    if (!contact) {
      results.push({
        toolCallId,
        result:
          'No record of this caller in our system. They are a new lead — gather their name, county, and what case they are calling about.',
      })
      continue
    }

    // 2. Find their most-recent active deal
    const { data: link } = await db
      .from('contact_deals')
      .select('deal_id, relationship')
      .eq('contact_id', contact.id)
      .limit(1)
      .maybeSingle()

    if (!link) {
      results.push({
        toolCallId,
        result: `Known contact: ${contact.name ?? contact.company ?? 'name unknown'}, but no deal linked. Ask what case they are calling about.`,
      })
      continue
    }

    // 3. Pull the deal context
    const { data: deal } = await db
      .from('deals')
      .select('id, name, status, address, meta')
      .eq('id', link.deal_id)
      .maybeSingle()

    if (!deal) {
      results.push({
        toolCallId,
        result: `Known contact: ${contact.name ?? contact.company ?? 'name unknown'}. Deal lookup failed; ask what case they are calling about.`,
      })
      continue
    }

    // 4. Compose a single-line briefing
    const meta = (deal.meta ?? {}) as Record<string, unknown>
    const county = (meta.county as string) ?? null
    const caseNo = (meta.courtCase as string) ?? null
    const parts: string[] = []
    parts.push(contact.name ?? contact.company ?? 'name unknown')
    if (caseNo && county) parts.push(`${county} case ${caseNo}`)
    else if (county) parts.push(`${county} County`)
    else if (caseNo) parts.push(`case ${caseNo}`)
    if (deal.status) parts.push(`status: ${deal.status}`)

    results.push({ toolCallId, result: parts.join(' · ') })
  }

  return jsonResponse({ results })
})
