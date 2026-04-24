import { createClient } from 'jsr:@supabase/supabase-js@2'

/**
 * generate-outreach — AI-drafts a personalized SMS for a queued outreach item.
 *
 * Called by the DCC Today view when it detects a 'queued' row in outreach_queue,
 * or when Nathan taps "Regenerate" with a coaching note.
 *
 * Flow:
 *   1. Reads the outreach_queue row + deal data
 *   2. Marks row status='generating'
 *   3. Builds context (deal info + prior messages + coach note)
 *   4. Calls Claude Sonnet to draft a short, personal SMS
 *   5. Updates row with draft_body, agent_reasoning, status='pending'
 *
 * Auth: requires anon key (Bearer token from DCC client).
 * Deployed with --no-verify-jwt so pg_cron can also call it via pg_net
 * using a shared secret if we wire that up later.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const SYSTEM_PROMPT = `You are Nathan's outreach assistant at FundLocators, an Ohio company that helps homeowners recover surplus funds left over after a tax foreclosure sale.

Nathan is a real person — warm, straightforward, not pushy. You draft short SMS messages he sends personally from his iPhone.

RULES:
- Sound like a human texting, not a marketing email
- 1-3 sentences max. Target under 160 characters. Hard limit 300.
- Lead with empathy or curiosity, not a sales pitch
- Be specific to this person's situation when you have data (county, surplus amount)
- For intros (day 0): mention there may be funds, include the personal portal link if available
- For follow-ups (day 3, day 7): acknowledge they may be busy, keep it short
- Never use: "I hope this message finds you well", exclamation points, emojis, "amazing opportunity", legal/medical advice
- Nathan's phone number is not shown — they reply directly to this message

Respond ONLY with valid JSON:
{
  "draft": "the full SMS text Nathan will send",
  "reasoning": "one sentence: why you wrote it this way given this person's situation"
}`

function corsResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const supabaseUrl    = Deno.env.get('SUPABASE_URL')!
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const anthropicKey   = Deno.env.get('ANTHROPIC_API_KEY')!

  const sb = createClient(supabaseUrl, serviceRoleKey)

  try {
    const body = await req.json()
    const { queue_id, coach_note } = body

    if (!queue_id) return corsResponse({ error: 'queue_id required' }, 400)

    // ── Load queue row ────────────────────────────────────────────────────
    const { data: qRow, error: qErr } = await sb
      .from('outreach_queue')
      .select('*')
      .eq('id', queue_id)
      .single()

    if (qErr || !qRow) return corsResponse({ error: 'Queue row not found' }, 404)
    if (qRow.status === 'sent') return corsResponse({ error: 'Already sent' }, 400)

    // ── Load deal ─────────────────────────────────────────────────────────
    const { data: deal } = await sb
      .from('deals')
      .select('id, name, address, type, lead_tier, sales_stage, meta, refundlocators_token')
      .eq('id', qRow.deal_id)
      .single()

    if (!deal) return corsResponse({ error: 'Deal not found' }, 404)

    const meta         = deal.meta || {}
    const firstName    = ((meta.homeownerName || deal.name || '').split(' - ')[0].split(' ')[0]) || 'there'
    const fullName     = (meta.homeownerName || deal.name || '').split(' - ')[0]
    const county       = meta.county || ''
    const surplus      = meta.estimatedSurplus ? `$${Number(meta.estimatedSurplus).toLocaleString()}` : null
    const portalLink   = deal.refundlocators_token
      ? `https://refundlocators.com/s/${deal.refundlocators_token}`
      : null
    const saleDate     = meta.sale_date || meta.saleDate || null

    // ── Load prior message history for this deal ──────────────────────────
    const { data: msgs } = await sb
      .from('messages_outbound')
      .select('body, direction, created_at, channel')
      .eq('deal_id', qRow.deal_id)
      .order('created_at', { ascending: false })
      .limit(10)

    const priorHistory = msgs && msgs.length > 0
      ? msgs
          .reverse()
          .map(m => `[${m.direction === 'inbound' ? 'HOMEOWNER' : 'NATHAN'}] ${m.body.slice(0, 200)}`)
          .join('\n')
      : null

    // ── Mark as generating ────────────────────────────────────────────────
    await sb.from('outreach_queue')
      .update({ status: 'generating', updated_at: new Date().toISOString() })
      .eq('id', queue_id)

    // ── Build user prompt ─────────────────────────────────────────────────
    const effectiveCoachNote = coach_note || qRow.coach_note

    const userPrompt = [
      `DEAL CONTEXT:`,
      `- Homeowner: ${fullName} (first name: ${firstName})`,
      `- Property: ${deal.address || 'unknown address'}`,
      county        ? `- County: ${county} County, Ohio` : null,
      surplus       ? `- Estimated surplus funds: ${surplus}` : null,
      saleDate      ? `- Sale date: ${saleDate}` : null,
      `- Lead tier: ${deal.lead_tier || 'A'} (A = highest equity)`,
      portalLink    ? `- Personal portal link: ${portalLink}` : null,
      `- Cadence day: ${qRow.cadence_day} (0=first contact, 3=follow-up day 3, 7=final touch)`,
      '',
      priorHistory
        ? `PRIOR CONVERSATION:\n${priorHistory}`
        : 'PRIOR CONVERSATION: None — this is the first contact.',
      '',
      effectiveCoachNote
        ? `NATHAN'S COACHING NOTE: "${effectiveCoachNote}"\nIncorporate this guidance.`
        : null,
      '',
      qRow.draft_version > 1 && qRow.draft_body
        ? `PREVIOUS DRAFT (v${qRow.draft_version - 1}, being improved):\n"${qRow.draft_body}"\nWrite a meaningfully different draft.`
        : null,
      '',
      'Draft the SMS now.',
    ].filter(Boolean).join('\n')

    // ── Call Claude ───────────────────────────────────────────────────────
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         anthropicKey,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-5',
        max_tokens: 512,
        system:     SYSTEM_PROMPT,
        messages:   [{ role: 'user', content: userPrompt }],
      }),
    })

    const aiData   = await aiRes.json()
    const rawText  = aiData?.content?.[0]?.text ?? ''

    // Strip markdown code fences if Claude wrapped the JSON (e.g. ```json ... ```)
    const cleanText = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()

    let parsed: { draft?: string; reasoning?: string } = {}
    try { parsed = JSON.parse(cleanText) } catch {
      // If Claude returned plain text instead of JSON, treat it as the draft
      parsed = { draft: cleanText, reasoning: 'Direct response from Claude.' }
    }

    const draftBody     = parsed.draft     || rawText.trim()
    const reasoning     = parsed.reasoning || ''
    const newVersion    = (qRow.draft_version || 1) + (qRow.draft_body ? 1 : 0)

    // Archive previous draft in history
    const newHistory = qRow.draft_body
      ? [
          ...(Array.isArray(qRow.draft_history) ? qRow.draft_history : []),
          {
            version:    qRow.draft_version,
            body:       qRow.draft_body,
            reasoning:  qRow.agent_reasoning,
            coach_note: qRow.coach_note,
            ts:         new Date().toISOString(),
          },
        ]
      : (Array.isArray(qRow.draft_history) ? qRow.draft_history : [])

    // ── Save draft ────────────────────────────────────────────────────────
    const { error: updateErr } = await sb.from('outreach_queue').update({
      draft_body:      draftBody,
      agent_reasoning: reasoning,
      coach_note:      effectiveCoachNote ?? null,
      draft_version:   newVersion,
      draft_history:   newHistory,
      status:          'pending',
      updated_at:      new Date().toISOString(),
    }).eq('id', queue_id)

    if (updateErr) {
      console.error('Failed to save draft:', updateErr)
      await sb.from('outreach_queue')
        .update({ status: 'failed', error_message: updateErr.message })
        .eq('id', queue_id)
      return corsResponse({ error: updateErr.message }, 500)
    }

    console.log(`✅ Draft generated  queue=${queue_id}  deal=${qRow.deal_id}  v${newVersion}`)

    return corsResponse({
      ok:        true,
      queue_id,
      draft:     draftBody,
      reasoning,
      version:   newVersion,
    })

  } catch (err) {
    console.error('generate-outreach error:', err)
    return corsResponse({ error: err.message }, 500)
  }
})
