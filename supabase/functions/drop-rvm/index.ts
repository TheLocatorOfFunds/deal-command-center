import { createClient } from 'jsr:@supabase/supabase-js@2'

/**
 * drop-rvm — Fish Audio TTS → Supabase Storage → (Slybroadcast delivery, when API approval lands)
 *
 * Replaces the prior Drop Cowboy implementation per Justin's 2026-05-05 RVM
 * provider evaluation:
 *   - TTS: Fish Audio (PAYG, ~$15/M chars, voice cloning included free tier)
 *   - Delivery: Slybroadcast (PAYG, $0.04-0.10/drop, API approval pending as of ship)
 *   - Until Slybroadcast API is approved, the function generates audio,
 *     uploads to Supabase Storage `rvm-audio` bucket, returns the public URL,
 *     and inserts messages_outbound with status='audio_generated'. No actual
 *     phone drop yet — that's a 5-minute change once the approval lands.
 *
 * Two call patterns:
 *
 *   Production (template-driven, cadence engine path):
 *     POST { template_id, deal_id, contact_id?, dry_run? }
 *     → fetches deal + contact + template, renders script with merge fields,
 *       generates audio, uploads to storage, returns mp3_url + message_id
 *
 *   Manual / test:
 *     POST { template_id, override_text?, override_first_name?, to_number, dry_run? }
 *     → renders override template (or override_text directly), generates audio
 *
 * Edge Function secrets required:
 *   - FISH_AUDIO_API_KEY        (set 2026-05-05)
 *   - NATHAN_VOICE_ID           (default voice if template doesn't specify; set 2026-05-05)
 *   - SUPABASE_URL              (auto)
 *   - SUPABASE_SERVICE_ROLE_KEY (auto)
 *   - SLYBROADCAST_*            (TODO when Slybroadcast API approval lands)
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const STORAGE_BUCKET = 'rvm-audio'
const FISH_AUDIO_TTS_URL = 'https://api.fish.audio/v1/tts'
const DEFAULT_TTS_MODEL = 's1'

// ───── Merge field rendering ─────────────────────────────────────────────────
// Replaces {first_name}, {county}, {case_number}, etc. in a template. Missing
// keys fall through to a sensible default rather than leaving "{first_name}"
// in the rendered audio.
const FALLBACKS: Record<string, string> = {
  first_name: 'there',
  full_name: 'there',
  county: 'your county',
  case_number: 'your case',
  property_address: 'your property',
  estimated_surplus: 'the surplus we found',
  sale_date: 'your sale date',
}

function renderTemplate(text: string, vars: Record<string, string | null | undefined>): string {
  return text.replace(/\{(\w+)\}/g, (_match, key) => {
    const v = vars[key]
    if (v && String(v).trim()) return String(v).trim()
    return FALLBACKS[key] ?? `{${key}}`
  })
}

function pickFirstName(name: string | null | undefined): string {
  if (!name) return ''
  const trimmed = name.trim()
  if (!trimmed) return ''
  return trimmed.split(/\s+/)[0]
}

function normalizePhone(raw: string): string {
  const digits = (raw || '').replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return raw
}

// ───── Fish Audio TTS ────────────────────────────────────────────────────────
async function generateAudio(args: {
  apiKey: string
  text: string
  voiceId: string
  model?: string
}): Promise<Uint8Array> {
  const res = await fetch(FISH_AUDIO_TTS_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${args.apiKey}`,
      'Content-Type': 'application/json',
      'model': args.model ?? DEFAULT_TTS_MODEL,
    },
    body: JSON.stringify({
      text: args.text,
      reference_id: args.voiceId,
      format: 'mp3',
      mp3_bitrate: 128,
      normalize: true,
      latency: 'normal',
    }),
  })
  if (!res.ok) {
    let detail: unknown
    try { detail = await res.json() } catch { detail = await res.text() }
    throw new Error(`Fish Audio TTS failed (${res.status}): ${JSON.stringify(detail)}`)
  }
  const buf = new Uint8Array(await res.arrayBuffer())
  if (buf.byteLength < 1024) {
    const text = new TextDecoder().decode(buf)
    throw new Error(`Fish Audio returned ${buf.byteLength} bytes, likely an error: ${text}`)
  }
  return buf
}

// ───── Storage upload ────────────────────────────────────────────────────────
async function uploadAudio(args: {
  sb: ReturnType<typeof createClient>
  audio: Uint8Array
  dealId: string | null
  templateId: string | null
}): Promise<{ path: string; publicUrl: string }> {
  const ts = Date.now()
  const folder = args.dealId ?? 'manual'
  const filename = `${args.templateId ?? 'adhoc'}-${ts}.mp3`
  const path = `${folder}/${filename}`

  const { error: uploadErr } = await args.sb.storage
    .from(STORAGE_BUCKET)
    .upload(path, args.audio, {
      contentType: 'audio/mpeg',
      cacheControl: '3600',
      upsert: false,
    })
  if (uploadErr) throw new Error(`Storage upload failed: ${uploadErr.message}`)

  const { data: urlData } = args.sb.storage.from(STORAGE_BUCKET).getPublicUrl(path)
  return { path, publicUrl: urlData.publicUrl }
}

// ───── Main handler ──────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const fishAudioKey = Deno.env.get('FISH_AUDIO_API_KEY')
  const defaultVoiceId = Deno.env.get('NATHAN_VOICE_ID')

  if (!fishAudioKey) {
    return new Response(JSON.stringify({ error: 'FISH_AUDIO_API_KEY not configured' }), {
      status: 503,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
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

    const sb = createClient(supabaseUrl, serviceRoleKey)
    const body = await req.json()
    const {
      template_id,
      deal_id,
      contact_id,
      override_text,
      override_first_name,
      to_number,
      dry_run = false,
    } = body

    // ─── Resolve template ─────────────────────────────────────────────────
    let template: any = null
    let scriptToRender: string
    let voiceId: string

    if (template_id) {
      const { data: tpl, error: tplErr } = await sb
        .from('rvm_templates')
        .select('*')
        .eq('id', template_id)
        .maybeSingle()
      if (tplErr || !tpl) {
        return new Response(JSON.stringify({ error: `Template not found: ${template_id}` }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }
      if (!tpl.active) {
        return new Response(JSON.stringify({ error: `Template is inactive: ${template_id}` }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }
      template = tpl
      scriptToRender = override_text ?? tpl.script
      voiceId = tpl.voice_id || defaultVoiceId || ''
    } else {
      if (!override_text) {
        return new Response(JSON.stringify({ error: 'Either template_id or override_text required' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }
      scriptToRender = override_text
      voiceId = defaultVoiceId || ''
    }

    if (!voiceId) {
      return new Response(JSON.stringify({ error: 'No voice_id available (template had none, NATHAN_VOICE_ID not set)' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ─── Resolve recipient details for merge field rendering ──────────────
    let deal: any = null
    let contact: any = null
    if (deal_id) {
      const { data } = await sb.from('deals').select('*').eq('id', deal_id).maybeSingle()
      deal = data
    }
    if (contact_id) {
      const { data } = await sb.from('contacts').select('*').eq('id', contact_id).maybeSingle()
      contact = data
    }

    const meta = (deal?.meta ?? {}) as Record<string, any>
    const recipientName = contact?.name ?? meta.homeownerName ?? meta.first_name ?? null
    const firstName = override_first_name ?? pickFirstName(recipientName)
    const phone = to_number
      ?? contact?.phone
      ?? meta.homeownerPhone
      ?? null
    const phoneE164 = phone ? normalizePhone(phone) : null

    const vars: Record<string, string> = {
      first_name: firstName || '',
      full_name: recipientName || '',
      county: deal?.county || meta.county || '',
      case_number: deal?.case_number || meta.case_number || '',
      property_address: deal?.address || '',
      estimated_surplus: meta.estimated_surplus_low
        ? `about ${meta.estimated_surplus_low}`
        : (meta.estimated_surplus || ''),
      sale_date: meta.sale_date || '',
    }
    const renderedScript = renderTemplate(scriptToRender, vars)

    // ─── Generate audio via Fish Audio ────────────────────────────────────
    const audio = await generateAudio({
      apiKey: fishAudioKey,
      text: renderedScript,
      voiceId,
      model: 's1',
    })

    // ─── Upload to Supabase Storage ───────────────────────────────────────
    const { path, publicUrl } = await uploadAudio({
      sb,
      audio,
      dealId: deal_id ?? null,
      templateId: template_id ?? null,
    })

    // ─── Insert messages_outbound record ──────────────────────────────────
    // Status = 'audio_generated' since Slybroadcast API approval is pending.
    // When delivery is wired, this becomes 'queued' → 'sent'.
    const { data: msgRow, error: msgErr } = await sb
      .from('messages_outbound')
      .insert({
        to_number:   phoneE164,
        from_number: null,
        body:        renderedScript,
        status:      dry_run ? 'dry_run' : 'audio_generated',
        sent_by:     userId,
        deal_id:     deal_id ?? null,
        contact_id:  contact_id ?? null,
        channel:     'rvm',
        direction:   'outbound',
        media_url:   publicUrl,
      })
      .select()
      .single()

    if (msgErr) {
      console.error('messages_outbound insert failed:', msgErr.message)
    }

    // TODO(slybroadcast): once API approval lands, swap this comment for an
    // actual delivery call. The audio is already public-readable at publicUrl.

    return new Response(JSON.stringify({
      ok: true,
      message_id: msgRow?.id ?? null,
      mp3_url: publicUrl,
      mp3_path: path,
      rendered_script: renderedScript,
      to_number: phoneE164,
      voice_id: voiceId,
      template_id: template_id ?? null,
      dry_run,
      delivery_pending: 'Slybroadcast API approval — audio is generated and stored, manual drop possible until then',
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  } catch (err) {
    console.error('drop-rvm error:', err)
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
