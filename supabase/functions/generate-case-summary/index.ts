// generate-case-summary
//
// Composes a narrative Case Intelligence summary for a single deal by
// assembling EVERY signal we have — deal meta, extracted doc fields,
// docket events, contacts, recent activity, messages, emails, notes —
// into one context blob, sending it to Claude, and caching the result
// on deals.meta.case_intel_summary.
//
// Button on the CaseIntelligence card in DCC invokes this; each
// invocation overwrites the cache with a fresh generation timestamp
// so Nathan knows how fresh the brief is.
//
// Request body: { deal_id }
// Response:     { text, generated_at, token_count }

import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const SYSTEM_PROMPT = `You are a real-estate intelligence analyst briefing Nathan (founder of RefundLocators/FundLocators, non-coder, business-first) on one deal.

You'll receive a JSON blob with everything we know: case docs (with extracted fields), docket events, contacts, recent outbound/inbound messages, calls (with summary + transcript preview), emails, internal notes, deal parameters, the homeowner's personalized-link page engagement counters (link_engagement), and any chat history the homeowner had with Lauren on the public site (lauren_chats).

Produce a Case Intelligence briefing with this exact structure (Markdown):

**Where this case stands** — 2–3 sentences. Lead with what's at stake dollar-wise, followed by timing (sale date / next court event / no court activity), and end with posture (who's acting on what).

**Facts Nathan + Justin need to know**
- 3-6 bullets, most important first
- Concrete dollar amounts, case numbers, dates, names — no filler
- When a specific filing exists in docket_events or documents (motion, order, decree, supplemental distribution, etc.), NAME it with its dollar amount and date — do NOT generalize to "court activity pending" if a specific named filing is the top signal
- Surface homeowner engagement when present (link_engagement: distinct viewers + last view; lauren_chats: what they asked Lauren about) — these are the strongest "ready to talk" tells for the caller
- Flag discrepancies (e.g., homeowner phone missing, attorney not linked, judgment vs appraised mismatch)
- Include what's been communicated (last text sent / last call) and what hasn't
- Call out one-click action items: "Homeowner hasn't replied to intro SMS (sent 3d ago) — consider Day-3 follow-up"

No preamble. No meta-commentary. No hedging language like "it appears" or "I believe." Facts + actions.`;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('POST only', { status: 405, headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization') || '';
    if (!authHeader.startsWith('Bearer ') || authHeader.length < 20) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const body = await req.json();
    const { deal_id } = body as { deal_id: string };
    if (!deal_id) return new Response(JSON.stringify({ error: 'deal_id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!anthropicKey) return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY missing' }), { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const db = createClient(supabaseUrl, serviceKey);

    // Pull everything we know about this deal in parallel
    const [dealRes, docsRes, eventsRes, contactsRes, messagesRes, callsRes, emailsRes, activityRes, notesRes, tasksRes] = await Promise.all([
      db.from('deals').select('*').eq('id', deal_id).single(),
      db.from('documents').select('name, extracted, extraction_status, created_at').eq('deal_id', deal_id).eq('extraction_status', 'done').order('created_at', { ascending: false }).limit(50),
      db.from('docket_events').select('event_type, event_date, description, is_backfill').eq('deal_id', deal_id).order('event_date', { ascending: false }).limit(25),
      db.from('contact_deals').select('relationship, contacts(name, phone, email, kind, kind_other, company, notes)').eq('deal_id', deal_id),
      db.from('messages_outbound').select('direction, body, created_at, status, contacts(name)').eq('deal_id', deal_id).order('created_at', { ascending: false }).limit(30),
      // Phase 4 (F1): pull the per-call summary + transcript so the brief
      // knows WHO each call was with and WHAT it was about, not just metadata.
      db.from('call_logs').select('direction, duration_seconds, status, started_at, summary, transcript, contacts(name)').eq('deal_id', deal_id).order('started_at', { ascending: false }).limit(15),
      db.from('emails').select('direction, subject, body_text, to_emails, cc_emails, created_at, status').eq('deal_id', deal_id).order('created_at', { ascending: false }).limit(15),
      db.from('activity').select('action, outcome, body, activity_type, created_at').eq('deal_id', deal_id).order('created_at', { ascending: false }).limit(40),
      db.from('deal_notes').select('title, body, created_at, updated_at').eq('deal_id', deal_id).order('updated_at', { ascending: false }).limit(20),
      db.from('tasks').select('title, due_date, done, priority, created_at').eq('deal_id', deal_id).order('created_at', { ascending: false }).limit(20),
    ]);

    const deal = dealRes.data;
    if (!deal) return new Response(JSON.stringify({ error: 'Deal not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    // #241 — token-dependent fetches (run after deal arrives so we have the token):
    //   * v_personalized_link_engagement — how many distinct viewers + when
    //   * lauren_conversations — what the homeowner asked Lauren on the public site
    // Direct table query (service-role bypasses RLS) instead of the admin-gated
    // lauren_conversations_for_deal RPC, which wouldn't return rows for a
    // service-role caller (auth.uid() is null → is_admin() false).
    let linkEngagement: any = null;
    let laurenChats: any[] = [];
    if (deal.refundlocators_token) {
      const [engRes, lrRes] = await Promise.all([
        db.from('v_personalized_link_engagement').select('*').eq('token', deal.refundlocators_token).maybeSingle(),
        db.from('lauren_conversations')
          .select('started_at, last_message_at, message_count, submitted_claim, seed_message, transcript')
          .eq('token', deal.refundlocators_token)
          .order('last_message_at', { ascending: false })
          .limit(5),
      ]);
      linkEngagement = engRes.data || null;
      laurenChats = lrRes.data || [];
    }

    // Build a compact context blob — strip fields that aren't useful for summarization
    const context = {
      deal: {
        id: deal.id, type: deal.type, status: deal.status, name: deal.name, address: deal.address,
        lead_tier: deal.lead_tier, is_30dts: deal.is_30dts, surplus_estimate: deal.surplus_estimate,
        days_to_sale: deal.days_to_sale, sales_stage: deal.sales_stage, last_contacted_at: deal.last_contacted_at,
        meta: deal.meta, created_at: deal.created_at, filed_at: deal.filed_at, closed_at: deal.closed_at,
      },
      documents: (docsRes.data || []).map((d: any) => ({
        name: d.name,
        doc_type: d.extracted?.document_type,
        summary: d.extracted?.summary,
        key_fields: d.extracted?.fields ? Object.fromEntries(
          Object.entries(d.extracted.fields).filter(([_, v]) => v != null).slice(0, 10)
        ) : null,
      })),
      docket_events: (eventsRes.data || []).filter((e: any) => !e.is_backfill).slice(0, 15),
      backfill_event_count: (eventsRes.data || []).filter((e: any) => e.is_backfill).length,
      contacts: (contactsRes.data || []).map((c: any) => ({
        name: c.contacts?.name, phone: c.contacts?.phone, email: c.contacts?.email,
        kind: c.contacts?.kind_other || c.contacts?.kind, company: c.contacts?.company,
        relationship_on_deal: c.relationship, notes: c.contacts?.notes,
      })),
      recent_messages: (messagesRes.data || []).slice(0, 15).map((m: any) => ({
        direction: m.direction, with: m.contacts?.name || null,
        body: (m.body || '').slice(0, 300), when: m.created_at, status: m.status,
      })),
      // F1: each call now carries who it was with + a summary (and a trimmed
      // transcript as backup) so the brief can reason about call content.
      recent_calls: (callsRes.data || []).map((c: any) => ({
        direction: c.direction, with: c.contacts?.name || null,
        duration_seconds: c.duration_seconds, status: c.status, when: c.started_at,
        summary: c.summary || null,
        transcript_preview: c.transcript ? String(c.transcript).slice(0, 500) : null,
      })),
      recent_emails: (emailsRes.data || []).map((e: any) => ({
        direction: e.direction, subject: e.subject,
        body_preview: (e.body_text || '').slice(0, 240),
        to: e.to_emails, cc: e.cc_emails, when: e.created_at, status: e.status,
      })),
      recent_activity: (activityRes.data || []).slice(0, 20).map((a: any) => ({
        action: a.action, outcome: a.outcome, body: (a.body || '').slice(0, 200),
        type: a.activity_type, when: a.created_at,
      })),
      team_notes: (notesRes.data || []).map((n: any) => ({
        title: n.title, body: (n.body || '').slice(0, 400), updated: n.updated_at,
      })),
      open_tasks: (tasksRes.data || []).filter((t: any) => !t.done),
      done_tasks_count: (tasksRes.data || []).filter((t: any) => t.done).length,
      // #241 — homeowner-behaviour signals: did they view their case page,
      // and did they chat with Lauren on the public site? Strong "ready to
      // talk" tells for the caller. Null when the personalized link
      // hasn't been minted yet (deal.refundlocators_token not set).
      link_engagement: linkEngagement ? {
        distinct_external_viewers: linkEngagement.distinct_external_fingerprints,
        external_views_last_24h: linkEngagement.external_views_last_24h,
        external_views_last_7d: linkEngagement.external_views_last_7d,
        last_external_view_at: linkEngagement.last_external_view_at,
        total_external_views: linkEngagement.total_external_views,
      } : null,
      lauren_chats: laurenChats.map((c: any) => ({
        when: c.last_message_at || c.started_at,
        seed: c.seed_message,
        message_count: c.message_count,
        submitted_claim: c.submitted_claim,
        // Trim transcript to keep token cost bounded — last ~10 turns is plenty.
        transcript_tail: Array.isArray(c.transcript) ? c.transcript.slice(-10) : c.transcript,
      })),
    };

    const userMsg = `Deal ID: ${deal_id}\nGenerated at: ${new Date().toISOString()}\n\nEverything we know (JSON):\n\n\`\`\`json\n${JSON.stringify(context, null, 2)}\n\`\`\``;

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1200,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMsg }],
      }),
    });

    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      return new Response(JSON.stringify({ error: 'Claude API failed', detail: detail.slice(0, 400) }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const apiBody = await resp.json();
    const text = (apiBody.content || []).map((b: any) => b.text || '').join('').trim();
    const inputTokens = apiBody.usage?.input_tokens || 0;
    const outputTokens = apiBody.usage?.output_tokens || 0;
    const tokenCount = inputTokens + outputTokens;
    const generatedAt = new Date().toISOString();

    // Cache on deals.meta.case_intel_summary
    const newMeta = { ...(deal.meta || {}), case_intel_summary: { text, generated_at: generatedAt, input_tokens: inputTokens, output_tokens: outputTokens } };
    await db.from('deals').update({ meta: newMeta }).eq('id', deal_id);

    return new Response(JSON.stringify({ text, generated_at: generatedAt, token_count: tokenCount }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
