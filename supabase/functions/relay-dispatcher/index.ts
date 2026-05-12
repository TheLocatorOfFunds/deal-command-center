import { createClient } from 'jsr:@supabase/supabase-js@2'

/**
 * relay-dispatcher — Cron-driven touch execution engine for FL Relay.
 *
 * Runs every 15 minutes via pg_cron. Finds all relay.scheduled_touches
 * where status IN ('pending','approved') AND scheduled_at <= now(),
 * and processes each one:
 *
 *   SMS:   Interpolates the template, writes to public.outreach_queue
 *          with relay_enrollment_id set. The DCC approval UI sees this
 *          row exactly like any other outreach item. dispatch-cadence-message
 *          (existing) fires when approved.
 *
 *          NOTE: Phase 1 = human-in-the-loop. All touches go through
 *          outreach_queue for Nathan/Justin to approve before sending.
 *          Phase 2 = flip auto_approve flag per sequence to bypass.
 *
 *   RVM:   Calls drop-rvm directly (no approval queue for RVM in Phase 1).
 *
 *   Email: Calls send-email (not yet implemented; touches are skipped with
 *          a 'skipped' status and a note).
 *
 * Template interpolation:
 *   Variables use {{var_name}} syntax and are pulled from
 *   enrollment.contact_data. If a required variable is missing, the
 *   touch is flagged 'failed' with an error_message so we know to fix
 *   the contact_data rather than sending a broken message.
 *
 * Response handling:
 *   If enrollment.status is NOT 'active' (opted_out, paused, completed,
 *   undeliverable), the touch is cancelled immediately. The inbound-sms
 *   function sets enrollment.status='opted_out' on STOP replies, which
 *   means the next dispatcher run cancels all remaining touches automatically.
 *
 * Auth: RELAY_SECRET header (pg_cron passes it via pg_net request headers).
 *
 * Env vars:
 *   SUPABASE_URL              (auto)
 *   SUPABASE_SERVICE_ROLE_KEY (auto)
 *   RELAY_SECRET              shared secret for cron calls
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

// ── Template interpolation ──────────────────────────────────────────────────
// Replaces {{var_name}} with contact_data[var_name].
// Returns null if any required variable is missing (caller should fail the touch).
function interpolate(template: string, data: Record<string, unknown>): string | null {
  const missing: string[] = []
  const result = template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (data[key] === undefined || data[key] === null || data[key] === '') {
      missing.push(key)
      return `[MISSING:${key}]`
    }
    return String(data[key])
  })
  if (missing.length) {
    console.warn(`interpolate: missing vars: ${missing.join(', ')}`)
    // Still return the result so the error message is informative,
    // but the caller should check for [MISSING:...] and fail the touch.
    return result
  }
  return result
}

function hasMissingVars(text: string): boolean {
  return /\[MISSING:[^\]]+\]/.test(text)
}

// ── Main handler ─────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

  const supabaseUrl    = Deno.env.get('SUPABASE_URL')!
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const relaySecret    = Deno.env.get('RELAY_SECRET')

  const headerSecret = req.headers.get('x-relay-secret') || ''
  if (relaySecret && headerSecret !== relaySecret) {
    return json({ error: 'unauthorized' }, 401)
  }

  const sb = createClient(supabaseUrl, serviceRoleKey)
  const now = new Date().toISOString()

  // ── Fetch due touches ─────────────────────────────────────────────────────
  const { data: dueTouches, error: fetchErr } = await sb
    .schema('relay')
    .from('scheduled_touches')
    .select(`
      id,
      enrollment_id,
      step_number,
      channel,
      variant_id,
      rendered_body,
      scheduled_at
    `)
    .in('status', ['pending', 'approved'])
    .lte('scheduled_at', now)
    .order('scheduled_at', { ascending: true })
    .limit(50) // process max 50 per run to stay within function timeout

  if (fetchErr) {
    console.error('relay-dispatcher: fetch error:', fetchErr.message)
    return json({ error: fetchErr.message }, 500)
  }

  if (!dueTouches?.length) {
    return json({ ok: true, processed: 0, message: 'no touches due' })
  }

  // ── Load enrollments for all due touches ──────────────────────────────────
  const enrollmentIds = [...new Set(dueTouches.map(t => t.enrollment_id))]
  const { data: enrollments } = await sb
    .schema('relay')
    .from('enrollments')
    .select('id, sequence_id, deal_id, contact_phone, contact_data, status')
    .in('id', enrollmentIds)

  const enrollmentMap = Object.fromEntries((enrollments || []).map(e => [e.id, e]))

  // ── Load sequence steps for all relevant sequences ────────────────────────
  const sequenceIds = [...new Set(Object.values(enrollmentMap).map((e: any) => e.sequence_id))]
  const { data: allSteps } = await sb
    .schema('relay')
    .from('sequence_steps')
    .select('sequence_id, step_number, channel, message_template, rvm_template_id, experiment_id')
    .in('sequence_id', sequenceIds)

  // Build a map: `${sequence_id}:${step_number}` -> step
  const stepMap: Record<string, any> = {}
  for (const s of (allSteps || [])) {
    stepMap[`${s.sequence_id}:${s.step_number}`] = s
  }

  // ── Load experiment variants for assigned variant_ids ─────────────────────
  const variantIds = dueTouches.filter(t => t.variant_id).map(t => t.variant_id as string)
  const { data: variants } = variantIds.length
    ? await sb.schema('relay').from('experiment_variants')
        .select('id, message_template').in('id', variantIds)
    : { data: [] }
  const variantMap = Object.fromEntries((variants || []).map(v => [v.id, v]))

  // ── Process each touch ────────────────────────────────────────────────────
  const results = { sent: 0, queued: 0, skipped: 0, failed: 0 }

  for (const touch of dueTouches) {
    const enrollment = enrollmentMap[touch.enrollment_id]

    // ── Cancel touches for inactive enrollments ───────────────────────────
    if (!enrollment || enrollment.status !== 'active') {
      await sb.schema('relay').from('scheduled_touches')
        .update({ status: 'cancelled', updated_at: new Date().toISOString() })
        .eq('id', touch.id)
      results.skipped++
      continue
    }

    const stepKey = `${enrollment.sequence_id}:${touch.step_number}`
    const step = stepMap[stepKey]
    if (!step) {
      await markFailed(sb, touch.id, `step not found: ${stepKey}`)
      results.failed++
      continue
    }

    // ── Resolve message template ──────────────────────────────────────────
    // Variant overrides step template if assigned.
    const rawTemplate: string | null = touch.variant_id
      ? (variantMap[touch.variant_id]?.message_template ?? step.message_template)
      : step.message_template

    // ── Route by channel ──────────────────────────────────────────────────
    if (touch.channel === 'sms') {
      if (!rawTemplate) {
        await markFailed(sb, touch.id, 'SMS touch has no message_template')
        results.failed++
        continue
      }

      const rendered = interpolate(rawTemplate, enrollment.contact_data as Record<string, unknown>)
      if (!rendered || hasMissingVars(rendered)) {
        await markFailed(sb, touch.id, `template interpolation failed: ${rendered}`)
        results.failed++
        continue
      }

      // Write to outreach_queue (Phase 1: human approval required)
      const { data: qRow, error: qErr } = await sb
        .from('outreach_queue')
        .insert({
          deal_id:              enrollment.deal_id || null,
          contact_phone:        enrollment.contact_phone,
          cadence_day:          touch.step_number, // maps step -> cadence_day for display
          draft_body:           rendered,
          agent_reasoning:      `Relay sequence step ${touch.step_number} — ${enrollment.sequence_id}`,
          status:               'pending', // human approves before send
          scheduled_for:        touch.scheduled_at,
          channel:              'sms',
          relay_enrollment_id:  touch.enrollment_id,
          relay_step_number:    touch.step_number,
        })
        .select('id')
        .single()

      if (qErr || !qRow) {
        await markFailed(sb, touch.id, `outreach_queue insert failed: ${qErr?.message}`)
        results.failed++
        continue
      }

      // Update scheduled_touch: status='firing', link to outreach_queue row
      await sb.schema('relay').from('scheduled_touches')
        .update({
          status:            'firing',
          rendered_body:     rendered,
          outreach_queue_id: qRow.id,
          updated_at:        new Date().toISOString(),
        })
        .eq('id', touch.id)

      // Update enrollment.current_step
      if (touch.step_number > (enrollment as any).current_step || 0) {
        await sb.schema('relay').from('enrollments')
          .update({ current_step: touch.step_number, updated_at: new Date().toISOString() })
          .eq('id', touch.enrollment_id)
      }

      results.queued++

    } else if (touch.channel === 'rvm') {
      // RVM: call drop-rvm directly. No approval queue for RVMs in Phase 1.
      // The rvm_template_id on the step drives what script plays.
      if (!step.rvm_template_id) {
        await markFailed(sb, touch.id, 'RVM touch has no rvm_template_id — set it on the sequence step')
        results.failed++
        continue
      }

      const rvmResp = await fetch(`${supabaseUrl}/functions/v1/drop-rvm`, {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${serviceRoleKey}`,
        },
        body: JSON.stringify({
          to:              enrollment.contact_phone,
          deal_id:         enrollment.deal_id || null,
          rvm_template_id: step.rvm_template_id,
          // Pass contact_data so drop-rvm can personalize the script
          contact_data:    enrollment.contact_data,
        }),
      })

      const rvmBody = await rvmResp.json().catch(() => ({}))

      if (!rvmResp.ok) {
        await markFailed(sb, touch.id, `drop-rvm failed ${rvmResp.status}: ${JSON.stringify(rvmBody).slice(0, 200)}`)
        results.failed++
        continue
      }

      await sb.schema('relay').from('scheduled_touches')
        .update({
          status:        'sent',
          rendered_body: `[RVM template: ${step.rvm_template_id}]`,
          sent_at:       new Date().toISOString(),
          updated_at:    new Date().toISOString(),
        })
        .eq('id', touch.id)

      await sb.schema('relay').from('enrollments')
        .update({ current_step: touch.step_number, updated_at: new Date().toISOString() })
        .eq('id', touch.enrollment_id)

      results.sent++

    } else if (touch.channel === 'email') {
      // Email not yet implemented — skip and log
      await sb.schema('relay').from('scheduled_touches')
        .update({
          status:        'skipped',
          error_message: 'Email channel not yet implemented',
          updated_at:    new Date().toISOString(),
        })
        .eq('id', touch.id)
      results.skipped++

    } else {
      await markFailed(sb, touch.id, `unknown channel: ${touch.channel}`)
      results.failed++
    }
  }

  console.log(`relay-dispatcher: processed ${dueTouches.length} touches`, results)
  return json({ ok: true, processed: dueTouches.length, ...results })
})

// ── Helpers ───────────────────────────────────────────────────────────────────
async function markFailed(sb: ReturnType<typeof createClient>, touchId: string, reason: string) {
  console.error(`relay-dispatcher: touch ${touchId} failed: ${reason}`)
  await sb.schema('relay').from('scheduled_touches')
    .update({
      status:        'failed',
      error_message: reason,
      updated_at:    new Date().toISOString(),
    })
    .eq('id', touchId)
}
