// morning-sweep — CEO Executive Briefing
//
// Fires daily at 12:00 UTC (8am EDT) via pg_cron.
// Sends an executive-level briefing to Nathan + Justin with:
//   - Deal status in plain English (what needs attention today)
//   - Asana / dev team status check
//   - On Mondays: full strategic section (what we've built, what to build,
//     what to stop, new tech opportunities, revenue ideas)
//
// Request: POST with header X-Morning-Sweep-Secret: <value>

import { createClient } from 'jsr:@supabase/supabase-js@2';

const DIGEST_EMAILS  = ['nathan@fundlocators.com', 'justin@fundlocators.com'];
const FROM_EMAIL     = 'RefundLocators <hello@refundlocators.com>';
const LATE_STAGE     = new Set(['filed', 'awaiting-distribution', 'probate', 'paid-out']);
const CLOSED_STAGE   = new Set(['closed', 'recovered', 'dead']);
const ASANA_PROJECT  = '1213259479535065'; // 🏰 CASTLE project

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });

  const secret = Deno.env.get('MORNING_SWEEP_SECRET');
  if (!secret) return new Response(JSON.stringify({ error: 'MORNING_SWEEP_SECRET not configured' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  if (req.headers.get('X-Morning-Sweep-Secret') !== secret)
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });

  try {
    const supabaseUrl  = Deno.env.get('SUPABASE_URL')!;
    const serviceKey   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
    const asanaToken   = Deno.env.get('ASANA_TOKEN');
    const db           = createClient(supabaseUrl, serviceKey);

    const now       = new Date();
    const isMonday  = now.getUTCDay() === 1;
    const dateStr   = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    const sinceIso  = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // ── 1. Active deals ───────────────────────────────────────────────────────
    const { data: deals } = await db.from('deals')
      .select('id, name, address, type, status, meta, lead_tier, sales_stage, filed_at, created_at')
      .not('status', 'in', `(${[...CLOSED_STAGE].map(s => `"${s}"`).join(',')})`);

    if (!deals || deals.length === 0)
      return new Response(JSON.stringify({ deals_total: 0, message: 'No active deals' }), { headers: { 'Content-Type': 'application/json' } });

    // ── 2. Pending outreach drafts ─────────────────────────────────────────────
    const { data: pendingDrafts } = await db.from('outreach_queue')
      .select('id, deal_id, contact_phone, cadence_day, draft_body, status, scheduled_for, draft_version')
      .in('status', ['queued', 'generating', 'pending'])
      .lte('scheduled_for', now.toISOString())
      .order('scheduled_for', { ascending: true });

    const draftsByDeal = new Map<string, any[]>();
    (pendingDrafts || []).forEach((d: any) => {
      const list = draftsByDeal.get(d.deal_id) || [];
      list.push(d);
      draftsByDeal.set(d.deal_id, list);
    });

    // ── 3. Classify each deal ──────────────────────────────────────────────────
    const classified: any[] = [];
    for (const deal of deals) {
      const [msgs, calls, emails, events, notes] = await Promise.all([
        db.from('messages_outbound').select('id, direction, body, created_at').eq('deal_id', deal.id).gte('created_at', sinceIso),
        db.from('call_logs').select('id, direction, status, started_at, duration_seconds').eq('deal_id', deal.id).gte('started_at', sinceIso),
        db.from('emails').select('id, direction, subject, created_at').eq('deal_id', deal.id).gte('created_at', sinceIso),
        db.from('docket_events').select('id, event_type, description, event_date').eq('deal_id', deal.id).eq('is_backfill', false).gte('received_at', sinceIso),
        db.from('deal_notes').select('id, title, body, updated_at').eq('deal_id', deal.id).gte('updated_at', sinceIso),
      ]);

      const dealDrafts  = draftsByDeal.get(deal.id) || [];
      const changeCount = (msgs.data?.length || 0) + (calls.data?.length || 0) + (emails.data?.length || 0) + (events.data?.length || 0) + (notes.data?.length || 0);
      const hasActivity = changeCount > 0 || dealDrafts.length > 0;
      const isLate      = LATE_STAGE.has(deal.status);

      classified.push({
        deal,
        bucket: hasActivity ? 'attention' : isLate ? 'late_quiet' : 'active_quiet',
        changeCount,
        pendingDrafts: dealDrafts,
        overnight: {
          messages: msgs.data || [],
          calls:    calls.data || [],
          emails:   emails.data || [],
          events:   events.data || [],
          notes:    notes.data || [],
        },
      });
    }

    const attention   = classified.filter(c => c.bucket === 'attention');
    const activeQuiet = classified.filter(c => c.bucket === 'active_quiet');
    const lateQuiet   = classified.filter(c => c.bucket === 'late_quiet');

    // ── 4. Refresh AI summaries on active deals ────────────────────────────────
    let refreshedCount = 0;
    for (const item of attention) {
      try {
        const r = await fetch(`${supabaseUrl}/functions/v1/generate-case-summary`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ deal_id: item.deal.id }),
        });
        if (r.ok) refreshedCount++;
      } catch (_) { /* non-fatal */ }
    }

    // ── 5. Asana — pull dev team task status ───────────────────────────────────
    let asanaSummary: any = null;
    if (asanaToken) {
      try {
        const asanaRes = await fetch(
          `https://app.asana.com/api/1.0/tasks?project=${ASANA_PROJECT}&opt_fields=name,completed,memberships.section.name&limit=50`,
          { headers: { 'Authorization': `Bearer ${asanaToken}`, 'Accept': 'application/json' } }
        );
        if (asanaRes.ok) {
          const asanaData = await asanaRes.json();
          const tasks = asanaData.data || [];
          const inProgress = tasks.filter((t: any) => !t.completed && t.memberships?.some((m: any) => m.section?.name === 'InProgress'));
          const toDo       = tasks.filter((t: any) => !t.completed && t.memberships?.some((m: any) => m.section?.name === 'ToDo'));
          const backlog    = tasks.filter((t: any) => !t.completed && t.memberships?.some((m: any) => m.section?.name === 'Backlog'));
          const recentDone = tasks.filter((t: any) => t.completed).slice(0, 3);
          asanaSummary = {
            in_progress: inProgress.map((t: any) => t.name),
            to_do:       toDo.map((t: any) => t.name),
            backlog:     backlog.map((t: any) => t.name),
            recently_completed: recentDone.map((t: any) => t.name),
          };
        }
      } catch (_) { /* non-fatal — Asana section skipped if token missing */ }
    }

    // ── 6. Build digest context for Claude ────────────────────────────────────
    const digestContext = {
      date: dateStr,
      is_monday: isMonday,
      counts: {
        active_total:   classified.length,
        attention:      attention.length,
        active_quiet:   activeQuiet.length,
        late_quiet:     lateQuiet.length,
        pending_drafts: (pendingDrafts || []).length,
      },
      attention: attention.map(c => ({
        name:    c.deal.name,
        status:  c.deal.status,
        tier:    c.deal.lead_tier,
        county:  c.deal.meta?.county,
        pending_drafts: c.pendingDrafts.length,
        overnight: {
          inbound_messages: c.overnight.messages
            .filter((m: any) => m.direction === 'inbound')
            .map((m: any) => ({ body: (m.body || '').slice(0, 240), when: m.created_at })),
          outbound_sent:   c.overnight.messages.filter((m: any) => m.direction === 'outbound').length,
          calls:           c.overnight.calls.map((x: any) => ({ direction: x.direction, status: x.status, duration: x.duration_seconds })),
          emails:          c.overnight.emails.map((e: any) => ({ direction: e.direction, subject: e.subject })),
          court_events:    c.overnight.events.map((ev: any) => ({ type: ev.event_type, description: ev.description, date: ev.event_date })),
          notes_updated:   c.overnight.notes.map((n: any) => ({ title: n.title, snippet: (n.body || '').slice(0, 150) })),
        },
      })),
      active_quiet: activeQuiet.map(c => ({ name: c.deal.name, status: c.deal.status, tier: c.deal.lead_tier })),
      late_quiet:   lateQuiet.map(c => {
        const filedAt = c.deal.filed_at || c.deal.meta?.filed_at;
        const days    = filedAt ? Math.floor((Date.now() - new Date(filedAt).getTime()) / 86400000) : null;
        return { name: c.deal.name, status: c.deal.status, days_waiting: days };
      }),
      asana: asanaSummary,
    };

    // ── 7. Claude — generate the executive briefing ────────────────────────────
    const systemPrompt = `You are writing the Monday Morning Memo for Nathan and Justin, co-founders of RefundLocators — a surplus fund recovery firm that helps homeowners claim money left over after foreclosure auctions. They want CEO-level plain English, not engineer speak.

Tone: Direct, confident, like a smart COO who knows the business inside and out. No fluff. No bullet soup. Talk to them like adults running a company — "you have 3 clients who replied overnight", not "3 inbound_messages were recorded in the messages_outbound table."

---

ALWAYS include these sections in this order:

## Good morning, Nathan & Justin 👋
One punchy sentence on the most important thing happening today.

## 📬 Clients who need you today
For each deal with overnight activity: name, what happened in plain English, what to do next. If they have AI drafts ready to send, lead with that — "You have a message ready to send to [Name] — just needs your thumbs-up." Mark time-sensitive items ⏰.
If nothing needs attention: "No clients reached out overnight. Clean slate."

## 📋 All active cases at a glance
A simple 2-column table: Client Name | Where They Stand. One line each. No jargon — "Waiting on court ruling" not "status: awaiting-distribution."

## 🛠 Dev team update
Based on the Asana data, tell them in plain English what Exore (the dev team) is working on, what's done, and what's waiting. Flag anything that seems stuck or off-track. If Asana data is null, say "Asana not connected — add ASANA_TOKEN to check dev status."

---

ON MONDAYS ONLY (when is_monday is true), add these sections after the dev team update:

## 🏆 What we've built (quick wins this week)
In 3-5 bullet points, summarize what's been built or improved in DCC (the Deal Command Center app), Castle (the lead scraping system), and any other systems. Plain English — "We can now send videos from Nathan's iPhone directly from the deal screen" not "MMS media_url support added to send-sms edge function."

## 🚀 What to build next
Top 3-5 recommendations in priority order. For each: what it is, why it matters to the business, rough effort (quick win / week / month). Focus on things that directly make money or save time.

## 💡 New tools & services worth looking at
2-4 specific third-party tools or technologies that could help RefundLocators right now. For each: what it does, how you'd use it, what it would cost or save. Be specific — "Twilio Verify for client identity checks" not "better authentication."

## 🛑 What to stop or pause
Honest list of things that are either not working, costing money without clear ROI, or distracting from the core business. Be direct.

## 💰 Revenue ideas
2-3 specific ideas for new revenue streams or ways to close more deals. Ground them in the actual business — surplus fund recovery, the relationships you have, the data you're already pulling. No vague "grow the business" suggestions.

---

Hard rules:
- Never say "it appears", "it seems", "I believe", "please note", or "it's worth mentioning"
- No technical jargon unless you immediately explain it in plain English
- Money amounts whenever you know them
- Keep the whole memo under 600 words on non-Monday, under 900 words on Monday
- If you reference a system name (Castle, DCC, Supabase, etc.), briefly say what it does the first time`;

    let digestText = '';
    if (anthropicKey) {
      try {
        const resp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model:      'claude-sonnet-4-5',
            max_tokens: 2500,
            system:     systemPrompt,
            messages:   [{ role: 'user', content: `Here is today's data:\n\n\`\`\`json\n${JSON.stringify(digestContext, null, 2)}\n\`\`\`` }],
          }),
        });
        if (resp.ok) {
          const body = await resp.json();
          digestText = (body.content || []).map((b: any) => b.text || '').join('').trim();
        }
      } catch (_) { /* non-fatal */ }
    }

    // Fallback plain text if Claude unavailable
    if (!digestText) {
      const lines: string[] = [`## Good morning, Nathan & Justin 👋`];
      if (attention.length === 0) {
        lines.push(`No clients reached out overnight. ${classified.length} active cases, all quiet.`);
      } else {
        lines.push(``, `## 📬 Clients who need you today`);
        attention.forEach(c => lines.push(`- **${c.deal.name}** · ${c.deal.status}${c.pendingDrafts.length > 0 ? ` · ${c.pendingDrafts.length} message(s) ready to send` : ''}`));
      }
      if (activeQuiet.length > 0) {
        lines.push(``, `## 📋 Active cases · quiet overnight`);
        activeQuiet.forEach(c => lines.push(`- ${c.deal.name} · ${c.deal.status}`));
      }
      if (lateQuiet.length > 0) {
        lines.push(``, `## ⏳ Waiting on court`);
        lateQuiet.forEach(c => {
          const days = (() => { const f = c.deal.filed_at || c.deal.meta?.filed_at; return f ? Math.floor((Date.now() - new Date(f).getTime()) / 86400000) : null; })();
          lines.push(`- ${c.deal.name} · ${c.deal.status}${days != null ? ` · ${days} days waiting` : ''}`);
        });
      }
      digestText = lines.join('\n');
    }

    // ── 8. Send email via Resend ───────────────────────────────────────────────
    let emailSent = false;
    let resendKey = Deno.env.get('RESEND_API_KEY');
    if (!resendKey) {
      const { data: kRow } = await db.from('vault.decrypted_secrets').select('decrypted_secret').eq('name', 'resend_api_key').single();
      resendKey = kRow?.decrypted_secret;
    }

    if (resendKey) {
      const htmlBody = digestText
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/^## (.+)$/gm, '</p><h2 style="font-size:18px;font-weight:700;color:#0b1f3a;margin:28px 0 10px;padding-bottom:6px;border-bottom:2px solid #e5dfd0;">$1</h2><p style="margin:0;">')
        .replace(/^### (.+)$/gm, '</p><h3 style="font-size:15px;font-weight:700;color:#17355e;margin:20px 0 8px;">$1</h3><p style="margin:0;">')
        .replace(/^- (.+)$/gm, '</p><li style="margin:5px 0;line-height:1.6;">$1</li><p style="margin:0;">')
        .replace(/\n\n/g, '</p><p style="margin:10px 0;">')
        .replace(/\n/g, '<br/>');

      const memoLabel = isMonday ? '📋 Monday Memo' : '🌅 Morning Brief';
      const subject   = attention.length === 0
        ? `${memoLabel} · ${now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · All quiet`
        : `${memoLabel} · ${now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · ${attention.length} client${attention.length > 1 ? 's' : ''} need${attention.length === 1 ? 's' : ''} you`;

      const fullHtml = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"/></head>
<body style="margin:0;padding:0;background:#f5f0e8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:660px;margin:0 auto;padding:24px 16px;">

    <!-- Header -->
    <div style="background:#0b1f3a;border-radius:12px 12px 0 0;padding:20px 28px 18px;">
      <div style="font-size:11px;font-weight:700;letter-spacing:.14em;color:#d8b560;text-transform:uppercase;margin-bottom:4px;">${memoLabel}</div>
      <div style="font-size:22px;font-weight:700;color:#fff;">${dateStr}</div>
      <div style="margin-top:12px;display:flex;gap:16px;flex-wrap:wrap;">
        <span style="background:rgba(255,255,255,0.1);border-radius:6px;padding:4px 10px;font-size:12px;color:#e2d9c5;">${classified.length} active cases</span>
        ${attention.length > 0 ? `<span style="background:#d97706;border-radius:6px;padding:4px 10px;font-size:12px;color:#fff;font-weight:700;">${attention.length} need your attention</span>` : `<span style="background:rgba(34,197,94,0.2);border-radius:6px;padding:4px 10px;font-size:12px;color:#86efac;">All quiet overnight</span>`}
        ${(pendingDrafts || []).length > 0 ? `<span style="background:rgba(251,191,36,0.15);border-radius:6px;padding:4px 10px;font-size:12px;color:#fbbf24;">${(pendingDrafts || []).length} AI draft${(pendingDrafts || []).length > 1 ? 's' : ''} ready to send</span>` : ''}
      </div>
    </div>

    <!-- Body -->
    <div style="background:#fff;padding:28px 28px 24px;border:1px solid #e5dfd0;border-top:none;">
      <div style="font-size:15px;line-height:1.7;color:#1a1a1a;">
        <p style="margin:0 0 10px;">${htmlBody}</p>
      </div>
    </div>

    <!-- Footer -->
    <div style="background:#f5f0e8;border:1px solid #e5dfd0;border-top:none;border-radius:0 0 12px 12px;padding:14px 28px;">
      <p style="margin:0;font-size:11px;color:#888;line-height:1.6;">
        ${refreshedCount > 0 ? `${refreshedCount} AI case summaries refreshed · ` : ''}
        Open DCC → <a href="https://app.refundlocators.com/" style="color:#17355e;text-decoration:none;">app.refundlocators.com</a>
      </p>
    </div>

  </div>
</body>
</html>`;

      try {
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: FROM_EMAIL, to: DIGEST_EMAILS, subject, html: fullHtml, text: digestText }),
        });
        emailSent = r.ok;
      } catch (_) { /* non-fatal */ }
    }

    return new Response(JSON.stringify({
      deals_total:       classified.length,
      deals_attention:   attention.length,
      deals_quiet:       activeQuiet.length,
      deals_late:        lateQuiet.length,
      deals_refreshed:   refreshedCount,
      pending_drafts:    (pendingDrafts || []).length,
      asana_connected:   !!asanaSummary,
      is_monday:         isMonday,
      email_sent:        emailSent,
      preview:           digestText.slice(0, 400),
    }), { headers: { 'Content-Type': 'application/json' } });

  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
});
