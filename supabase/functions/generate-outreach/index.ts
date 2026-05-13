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

Nathan is a real person - warm, straightforward, not pushy. You draft short SMS messages he sends personally from his iPhone.

RULES:
- Sound like a human texting, not a marketing email
- 1-3 sentences max. Target under 160 characters. Hard limit 300.
- Lead with empathy or curiosity, not a sales pitch
- Be specific to this person's situation when you have data (county, surplus amount)
- For intros (day 0): mention there may be funds, include the personal portal link if available
- For follow-ups (day 3, day 7): acknowledge they may be busy, keep it short
- Never use: em dashes (-- or —), exclamation points, emojis, "I hope this message finds you well", "amazing opportunity", legal/medical advice
- Use plain punctuation only: periods, commas, question marks. No dashes used as connectors.
- Nathan's phone number is not shown. They reply directly to this message.

VERIFIED vs ESTIMATED — language matters:
- When the DEAL CONTEXT says "Verified surplus: $X" it means the auction has happened
  and a real surplus amount is on file. Reference it directly ("you have about $X
  sitting with the county").
- When the DEAL CONTEXT says "Estimated surplus: $X" it means we're projecting from
  judgment vs sale value. Use softer language ("there may be roughly $X").
- If a "Sale completed on YYYY-MM-DD" is shown, you may anchor to it ("your case
  closed last month / a few weeks ago"). Never give an exact date in the SMS itself
  unless directly asked — sounds robotic. Use relative phrasing.
- If a "Latest docket event" is shown and it's recent (within ~30 days), you can
  reference activity on the case generally without naming the event. e.g. "I saw
  things have been moving on your case recently." Do not quote docket text.

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
    const portalLink   = deal.refundlocators_token
      ? `https://refundlocators.com/s/${deal.refundlocators_token}`
      : null

    // Verified vs estimated surplus — Director's writeback (intel-main
    // /api/cron/sync-deal-updates, every 30 min) now stamps meta.walkerVerified
    // and meta.salePrice when the auction has confirmed. Use the strongest
    // signal we have. Prompt language adapts based on which one we pass.
    const walkerVerified  = meta.walkerVerified === true
    const hasSale         = !!meta.salePrice && Number(meta.salePrice) > 0
    const isVerified      = walkerVerified && hasSale
    const surplusAmount   = meta.estimatedSurplus
      ? Number(meta.estimatedSurplus)
      : null
    const surplusFormatted = surplusAmount
      ? `$${surplusAmount.toLocaleString()}`
      : null
    const saleDate     = meta.saleDate || meta.sale_date || null

    // ── Load latest docket event for activity context ─────────────────────
    // Per the May 13 meeting: drafts should be able to say "I saw things have
    // been moving on your case recently" when there's been activity, but
    // never quote docket text. One latest event is enough for that signal.
    const { data: latestDocket } = await sb
      .from('docket_events')
      .select('event_type, event_date, detected_at')
      .eq('deal_id', qRow.deal_id)
      .order('event_date', { ascending: false, nullsFirst: false })
      .limit(1)

    const recentDocket = latestDocket && latestDocket.length > 0
      ? latestDocket[0]
      : null

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

    // ── Recent thumbs-down feedback on past drafts for this deal ──────────
    // Per the May 13 meeting (training loop): when the user has flagged a
    // prior draft as wrong, we should learn from that next time. Pull the
    // most recent thumbs-down text_draft feedback for this deal and feed
    // the reason + suggested correction back into the prompt as guidance.
    const { data: pastFeedback } = await sb
      .from('agent_feedback')
      .select('reason, suggested_correction, context, created_at')
      .eq('deal_id', qRow.deal_id)
      .eq('kind', 'text_draft')
      .eq('signal', 'down')
      .order('created_at', { ascending: false })
      .limit(3)

    const feedbackContext = pastFeedback && pastFeedback.length > 0
      ? pastFeedback.map((f, i) => {
          const parts = [`#${i + 1}: ${f.reason || '(no reason given)'}`]
          if (f.suggested_correction) parts.push(`should have been: "${f.suggested_correction}"`)
          return parts.join(' | ')
        }).join('\n')
      : null

    // ── Mark as generating ────────────────────────────────────────────────
    await sb.from('outreach_queue')
      .update({ status: 'generating', updated_at: new Date().toISOString() })
      .eq('id', queue_id)

    // ── Build user prompt ─────────────────────────────────────────────────
    const effectiveCoachNote = coach_note || qRow.coach_note

    const surplusLine = surplusFormatted
      ? (isVerified
          ? `- Verified surplus: ${surplusFormatted} (auction completed, real dollar amount on file)`
          : `- Estimated surplus: ${surplusFormatted} (projected from judgment vs sale, not yet confirmed)`)
      : null

    const saleDateLine = saleDate && isVerified
      ? `- Sale completed on ${saleDate}`
      : (saleDate ? `- Sale date on file: ${saleDate}` : null)

    const docketLine = recentDocket
      ? (() => {
          const eventDateStr = recentDocket.event_date || recentDocket.detected_at
          const days = eventDateStr
            ? Math.floor((Date.now() - new Date(eventDateStr).getTime()) / 86400000)
            : null
          if (days == null) return `- Latest docket event: ${recentDocket.event_type || 'activity on file'}`
          if (days <= 3)   return `- Latest docket event: ${recentDocket.event_type || 'activity'}, ${days === 0 ? 'today' : days + 'd ago'} (very recent)`
          if (days <= 30)  return `- Latest docket event: ${recentDocket.event_type || 'activity'}, ${days}d ago (recent)`
          return `- Latest docket event: ${recentDocket.event_type || 'activity'}, ${days}d ago`
        })()
      : null

    const userPrompt = [
      `DEAL CONTEXT:`,
      `- Homeowner: ${fullName} (first name: ${firstName})`,
      `- Property: ${deal.address || 'unknown address'}`,
      county        ? `- County: ${county} County, Ohio` : null,
      surplusLine,
      saleDateLine,
      docketLine,
      `- Lead tier: ${deal.lead_tier || 'A'} (A = highest equity)`,
      portalLink    ? `- Personal portal link: ${portalLink}` : null,
      `- Cadence day: ${qRow.cadence_day} (0=first contact, 3=follow-up day 3, 7=final touch)`,
      '',
      priorHistory
        ? `PRIOR CONVERSATION:\n${priorHistory}`
        : 'PRIOR CONVERSATION: None — this is the first contact.',
      '',
      feedbackContext
        ? `PAST CORRECTIONS ON THIS DEAL (avoid repeating these mistakes):\n${feedbackContext}`
        : null,
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
