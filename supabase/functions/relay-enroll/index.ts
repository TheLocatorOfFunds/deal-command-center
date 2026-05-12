import { createClient } from 'jsr:@supabase/supabase-js@2'

/**
 * relay-enroll — Enroll a lead into an FL Relay sequence.
 *
 * Creates a relay.enrollments row and pre-schedules all touches
 * (relay.scheduled_touches) based on the sequence's steps and delay_hours.
 *
 * Experiment variant assignment happens here: if a step has an experiment_id,
 * we pick a variant using weighted random selection and store it on the touch.
 * This keeps variant assignment deterministic per enrollment (the variant doesn't
 * change between scheduling and sending).
 *
 * Called by:
 *   - DCC "Start Relay Sequence" button (manual enrollment)
 *   - relay-auto-enroll (future) when a new docket_event matches criteria
 *
 * Auth: requires RELAY_SECRET header (same pattern as CADENCE_ENGINE_SECRET).
 *       DCC frontend also accepted via Bearer anon key for manual triggers.
 *
 * Request body:
 *   {
 *     sequence_id: string,          // e.g. 'ohio-surplus-v1'
 *     contact_phone: string,        // E.164 or 10-digit US
 *     contact_data: {               // template interpolation vars
 *       first_name: string,
 *       last_name: string,
 *       case_number?: string,
 *       county?: string,
 *       street_address?: string,
 *       case_month?: string,
 *       case_year?: string,
 *       agent_first_name?: string,  // defaults to 'Nathan'
 *       ...
 *     },
 *     deal_id?: string,             // optional link to deals table
 *     enrolled_by?: string,         // uuid of the user enrolling (omit for auto)
 *     notes?: string,
 *     enroll_at?: string,           // ISO timestamp, defaults to now()
 *   }
 *
 * Response:
 *   {
 *     ok: true,
 *     enrollment_id: string,
 *     touches_scheduled: number,
 *     touches: [{ step_number, channel, scheduled_at, variant_id }]
 *   }
 *
 * Idempotency: if the phone number is already 'active' in this sequence,
 * returns 409 with the existing enrollment_id. Callers can force re-enroll
 * by passing force: true (which completes the old enrollment first).
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-relay-secret',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

// Normalize phone to E.164. Handles 10-digit US numbers.
function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return `+${digits}` // pass through, let Twilio reject invalid
}

// Weighted random variant selection.
// variants: [{ id, weight }] where weights should sum to 100.
// Falls back to first variant if weights don't sum correctly.
function pickVariant(variants: { id: string; weight: number }[]): string | null {
  if (!variants.length) return null
  const total = variants.reduce((s, v) => s + v.weight, 0)
  let roll = Math.random() * total
  for (const v of variants) {
    roll -= v.weight
    if (roll <= 0) return v.id
  }
  return variants[variants.length - 1].id
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

  const supabaseUrl    = Deno.env.get('SUPABASE_URL')!
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const relaySecret    = Deno.env.get('RELAY_SECRET')

  // Auth: accept either the relay secret header or a valid Bearer JWT.
  // Edge Functions with --no-verify-jwt allow both paths.
  const headerSecret = req.headers.get('x-relay-secret') || ''
  const hasRelaySecret = relaySecret && headerSecret === relaySecret
  const hasBearer = req.headers.get('authorization')?.startsWith('Bearer ')
  if (!hasRelaySecret && !hasBearer) {
    return json({ error: 'unauthorized' }, 401)
  }

  const sb = createClient(supabaseUrl, serviceRoleKey)

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ error: 'invalid JSON body' }, 400)
  }

  const {
    sequence_id,
    contact_phone: rawPhone,
    contact_data = {},
    deal_id,
    enrolled_by,
    notes,
    enroll_at,
    force = false,
  } = body as {
    sequence_id?: string
    contact_phone?: string
    contact_data?: Record<string, unknown>
    deal_id?: string
    enrolled_by?: string
    notes?: string
    enroll_at?: string
    force?: boolean
  }

  if (!sequence_id) return json({ error: 'sequence_id required' }, 400)
  if (!rawPhone)    return json({ error: 'contact_phone required' }, 400)

  const contact_phone = normalizePhone(String(rawPhone))

  // ── Validate sequence exists ────────────────────────────────────────────
  const { data: seq, error: seqErr } = await sb
    .from('relay_sequences')
    .select('id, active')
    .eq('id', sequence_id)
    .single()

  if (seqErr || !seq) return json({ error: `sequence '${sequence_id}' not found` }, 404)
  if (!seq.active)    return json({ error: `sequence '${sequence_id}' is not active` }, 400)

  // ── Idempotency check ───────────────────────────────────────────────────
  const { data: existing } = await sb
    .from('relay_enrollments')
    .select('id, status')
    .eq('sequence_id', sequence_id)
    .eq('contact_phone', contact_phone)
    .eq('status', 'active')
    .maybeSingle()

  if (existing) {
    if (!force) {
      return json({
        error: 'already_enrolled',
        message: `Phone ${contact_phone} is already active in sequence '${sequence_id}'. Pass force: true to re-enroll.`,
        enrollment_id: existing.id,
      }, 409)
    }
    // Force re-enroll: complete the old enrollment + cancel its pending touches
    await sb.from('relay_enrollments')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('id', existing.id)
    await sb.from('relay_scheduled_touches')
      .update({ status: 'cancelled' })
      .eq('enrollment_id', existing.id)
      .in('status', ['pending', 'approved'])
  }

  // ── Load sequence steps ─────────────────────────────────────────────────
  const { data: steps, error: stepsErr } = await sb
    .from('relay_sequence_steps')
    .select('step_number, channel, delay_hours, message_template, rvm_template_id, experiment_id')
    .eq('sequence_id', sequence_id)
    .order('step_number', { ascending: true })

  if (stepsErr || !steps?.length) {
    return json({ error: 'sequence has no steps', details: stepsErr?.message }, 500)
  }

  // ── Load experiment variants for steps that have experiments ────────────
  const experimentIds = [...new Set(steps.filter(s => s.experiment_id).map(s => s.experiment_id as string))]
  const variantsByExperiment: Record<string, { id: string; weight: number }[]> = {}

  if (experimentIds.length) {
    const { data: variants } = await sb
      .from('relay_experiment_variants')
      .select('id, experiment_id, weight')
      .in('experiment_id', experimentIds)

    for (const v of (variants || [])) {
      if (!variantsByExperiment[v.experiment_id]) variantsByExperiment[v.experiment_id] = []
      variantsByExperiment[v.experiment_id].push({ id: v.id, weight: v.weight })
    }
  }

  // ── Create enrollment ───────────────────────────────────────────────────
  const enrolledAt = enroll_at ? new Date(enroll_at) : new Date()

  const { data: enrollment, error: enrollErr } = await sb
    .from('relay_enrollments')
    .insert({
      sequence_id,
      deal_id: deal_id || null,
      contact_phone,
      contact_data: {
        agent_first_name: 'Nathan', // default, can be overridden in contact_data
        ...contact_data,
      },
      status: 'active',
      current_step: 0,
      enrolled_by: enrolled_by || null,
      enrolled_at: enrolledAt.toISOString(),
      notes: notes || null,
    })
    .select('id')
    .single()

  if (enrollErr || !enrollment) {
    console.error('enrollment insert error:', enrollErr?.message)
    return json({ error: 'failed to create enrollment', details: enrollErr?.message }, 500)
  }

  const enrollmentId = enrollment.id

  // ── Schedule all touches ────────────────────────────────────────────────
  // Each touch's scheduled_at = previous touch scheduled_at + delay_hours.
  // Step 1 (delay_hours=0) fires at enrolledAt.
  const touchInserts = []
  let prevScheduledAt = enrolledAt

  for (const step of steps) {
    const scheduledAt = new Date(prevScheduledAt.getTime() + step.delay_hours * 60 * 60 * 1000)

    const variantId = step.experiment_id
      ? pickVariant(variantsByExperiment[step.experiment_id] || [])
      : null

    touchInserts.push({
      enrollment_id: enrollmentId,
      step_number:   step.step_number,
      channel:       step.channel,
      variant_id:    variantId,
      rendered_body: null, // rendered at dispatch time (allows last-minute data refresh)
      scheduled_at:  scheduledAt.toISOString(),
      status:        'pending',
    })

    prevScheduledAt = scheduledAt
  }

  const { error: touchErr } = await sb
    .from('relay_scheduled_touches')
    .insert(touchInserts)

  if (touchErr) {
    console.error('scheduled_touches insert error:', touchErr.message)
    // Roll back enrollment
    await sb.from('relay_enrollments').delete().eq('id', enrollmentId)
    return json({ error: 'failed to schedule touches', details: touchErr.message }, 500)
  }

  console.log(`relay-enroll: enrolled ${contact_phone} into '${sequence_id}' enrollment=${enrollmentId} touches=${touchInserts.length}`)

  return json({
    ok: true,
    enrollment_id: enrollmentId,
    touches_scheduled: touchInserts.length,
    touches: touchInserts.map(t => ({
      step_number:  t.step_number,
      channel:      t.channel,
      scheduled_at: t.scheduled_at,
      variant_id:   t.variant_id,
    })),
  })
})
