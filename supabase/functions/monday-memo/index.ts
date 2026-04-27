// monday-memo — Executive Business Summary
//
// Runs Sunday at 07:00 UTC (3am EDT) via pg_cron.
// Sends Monday morning to Nathan + Justin from hello@fundlocators.com.
//
// Acts as an AI product manager for the whole business:
//   - Pulls GitHub commits from the past 7 days across all repos
//   - Pulls DCC live data (deals, outreach pipeline, leads)
//   - Claude synthesizes: what shipped, what to build, what to kill,
//     relevant AI/tech tools worth evaluating, revenue ideas
//
// Separate from morning-sweep (Nathan's daily client digest).
// This is the strategic layer — one email per week.
//
// Auth: POST with X-Monday-Memo-Secret header
// Schedule: 0 7 * * 0 (Sunday 7am UTC)

import { createClient } from 'jsr:@supabase/supabase-js@2';

const DIGEST_EMAILS = ['nathan@fundlocators.com', 'justin@fundlocators.com'];
const FROM_EMAIL    = 'RefundLocators <hello@fundlocators.com>';

// GitHub repos to pull commit history from (add more as needed).
// Private repos require a GITHUB_TOKEN secret with `repo:read` scope —
// without it, those repos return 404 and silently get skipped (the
// per-repo fetch is wrapped in try/catch).
const GITHUB_REPOS = [
  'TheLocatorOfFunds/deal-command-center',
  'TheLocatorOfFunds/ohio-intel',          // private — needs GITHUB_TOKEN
  'TheLocatorOfFunds/refundlocators-next', // private — needs GITHUB_TOKEN
];

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });

  const secret = Deno.env.get('MONDAY_MEMO_SECRET');
  if (!secret) return new Response(JSON.stringify({ error: 'MONDAY_MEMO_SECRET not configured' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  if (req.headers.get('X-Monday-Memo-Secret') !== secret)
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });

  try {
    const supabaseUrl  = Deno.env.get('SUPABASE_URL')!;
    const serviceKey   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY')!;
    const githubToken  = Deno.env.get('GITHUB_TOKEN'); // optional — boosts rate limit from 60 to 5000 req/hr
    const db           = createClient(supabaseUrl, serviceKey);

    const now        = new Date();
    const weekAgoIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const dateStr    = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

    const ghHeaders: Record<string, string> = { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (githubToken) ghHeaders['Authorization'] = `Bearer ${githubToken}`;

    // ── 1. GitHub: commits this week across all repos ─────────────────────────
    const allCommits: any[] = [];
    for (const repo of GITHUB_REPOS) {
      try {
        const r = await fetch(
          `https://api.github.com/repos/${repo}/commits?since=${weekAgoIso}&per_page=100`,
          { headers: ghHeaders }
        );
        if (r.ok) {
          const data = await r.json();
          if (Array.isArray(data)) {
            data.forEach((c: any) => {
              allCommits.push({
                repo,
                sha:     c.sha?.slice(0, 7),
                message: c.commit?.message?.split('\n')[0]?.slice(0, 120),
                author:  c.commit?.author?.name,
                date:    c.commit?.author?.date,
              });
            });
          }
        }
      } catch (_) { /* non-fatal — skip repo if unreachable */ }
    }

    // ── 2. DCC live data snapshot + team communications ───────────────────────
    const [
      { data: deals },
      { data: recentLeads },
      { data: outreachStats },
      { data: recentMessages },
      { data: recentActivity },
      { data: teamComms },
    ] = await Promise.all([
      db.from('deals')
        .select('id, name, type, status, lead_tier, meta, created_at')
        .not('status', 'in', '("closed","recovered","dead")'),
      db.from('leads')
        .select('id, name, status, created_at')
        .gte('created_at', weekAgoIso)
        .order('created_at', { ascending: false })
        .limit(20),
      db.from('outreach_queue')
        .select('status')
        .gte('created_at', weekAgoIso),
      db.from('messages_outbound')
        .select('id, direction, channel, created_at')
        .gte('created_at', weekAgoIso),
      db.from('activity')
        .select('action, created_at')
        .gte('created_at', weekAgoIso)
        .order('created_at', { ascending: false })
        .limit(50),
      // Pull this week's communication summaries (written by gmail-sync Saturday night)
      db.from('team_communications')
        .select('person, source, summary')
        .gte('week_of', weekAgoIso.split('T')[0]),
    ]);

    // Summarize outreach funnel
    const outreachByStatus: Record<string, number> = {};
    (outreachStats || []).forEach((r: any) => {
      outreachByStatus[r.status] = (outreachByStatus[r.status] || 0) + 1;
    });

    // Message volume
    const msgSent     = (recentMessages || []).filter((m: any) => m.direction === 'outbound').length;
    const msgReceived = (recentMessages || []).filter((m: any) => m.direction === 'inbound').length;

    // Deal pipeline
    const dealsByStatus: Record<string, number> = {};
    (deals || []).forEach((d: any) => { dealsByStatus[d.status] = (dealsByStatus[d.status] || 0) + 1; });

    const businessContext = {
      company:     'RefundLocators — surplus fund recovery firm. We help homeowners claim money left over after a foreclosure auction. We find the leads (people owed money), contact them, sign them as clients, then recover the funds through the court system.',
      team:        'Nathan (co-founder, sales & operations) + Justin (co-founder, product & tech). Small team — every hour and dollar counts.',
      tech_stack:  'DCC (Deal Command Center) — internal React app on GitHub Pages, Supabase backend. Castle — scraping system that monitors Ohio court foreclosure auctions and generates leads. Ohio Intel — VPS-based system for deeper data enrichment. refundlocators.com — public site with personalized landing pages per lead. GoHighLevel — CRM. Resend — transactional email. iMessage bridge via Mac Mini for SMS outreach.',
      week_ending: dateStr,
    };

    const businessData = {
      github_commits_this_week: allCommits.length,
      commits: allCommits.slice(0, 40), // cap at 40 to stay within context
      active_deals: (deals || []).length,
      deal_pipeline: dealsByStatus,
      new_leads_this_week: (recentLeads || []).length,
      outreach_funnel_this_week: outreachByStatus,
      messages_sent_this_week: msgSent,
      messages_received_this_week: msgReceived,
      notable_activity: (recentActivity || []).slice(0, 20).map((a: any) => a.action),
    };

    // ── 3. Claude: generate the executive memo ────────────────────────────────
    const systemPrompt = `You are the AI product manager and strategic advisor for RefundLocators. Every Sunday night you compile a Monday morning executive briefing for Nathan and Justin, the two co-founders.

Your job is to look at what was built this week, what's happening in the business, and give them clear strategic direction for the week ahead — all in plain, direct language. You are like a smart COO who has read everything that happened and is telling them what matters.

Tone: Confident, direct, no fluff. Write like a smart person talking to two smart founders. No "it appears", no "it seems", no "I believe". No bullet soup — every bullet should carry real information. If you reference a system name, briefly say what it does the first time.

---

FORMAT — output exactly these sections in this order:

## RECOMMENDATION
One punchy paragraph. The single most important thing they should do THIS WEEK for the business. Be specific. If there's a revenue action to take, say so. If there's a risk to address, name it. Don't hedge.

## WHAT SHIPPED THIS WEEK
Translate the GitHub commits into plain English wins. Group by system (DCC, Castle, Ohio Intel, refundlocators.com, etc.). Skip trivial commits (merge commits, typo fixes, dependency bumps). Focus on things that changed what the business can do. Use past tense, no jargon. Dollar amounts if relevant.

## BUSINESS PULSE
3-5 sentences covering the live data: deal pipeline, outreach volume, lead flow, client communications, anything notable from emails or meetings. Tell them what the numbers mean for the business, not just what they are. If the communications context includes notable case updates, attorney correspondence, or client conversations — mention the specific details.

## RELEVANT AI & TECH THIS WEEK
3-5 specific tools, platforms, or AI developments that are directly relevant to RefundLocators right now. For each: what it is (one sentence), why it matters to this specific business, how you'd use it. No generic "AI is getting better" statements. Ground every item in how it helps win more cases, find more leads, or move faster than competitors.

Focus on:
- New AI models or capabilities (Claude, GPT, etc.) that unlock something specific
- Tools for skip tracing, property data, court records, or outreach
- Voice/SMS/outreach automation improvements
- Legal tech or property data providers
- Anything that could replace or improve current vendors (BatchData, BrightData, GoHighLevel, 2captcha, Drop Cowboy, etc.)

## WHAT TO BUILD NEXT
Top 3-5 items in priority order. For each: what it is (plain English), why it moves the needle for the business (revenue, efficiency, or risk reduction), and rough effort (quick win = days, medium = week, big = month+). Be opinionated — rank by business impact, not technical interest.

## WHAT TO STOP OR PAUSE
Honest list of things that are costing time or money without clear ROI. Be direct. If something is redundant, say so. If a vendor relationship isn't working, name it.

## REVENUE IDEAS
2-3 specific, grounded ideas for new revenue or more closed deals. Must be actionable within 30 days. No vague "expand the business" suggestions. Root every idea in the real business — the data you have, the relationships you have, the counties you're already in.

---

Hard rules:
- Total length: 600-800 words
- Every section must have real content — never leave a section with filler
- If commits are sparse, say so honestly and focus on what the business needs
- Specific numbers always beat vague descriptions`;

    // Build communications context block from team_communications table
    let commsBlock = '';
    if (teamComms && teamComms.length > 0) {
      const sections: string[] = [];
      const sources = ['gmail', 'granola'];
      const people  = ['justin', 'nathan', 'team'];
      for (const source of sources) {
        for (const person of people) {
          const row = teamComms.find((r: any) => r.source === source && r.person === person);
          if (row?.summary) {
            const label = source === 'gmail'
              ? `${person.charAt(0).toUpperCase() + person.slice(1)}'s emails this week`
              : `${person.charAt(0).toUpperCase() + person.slice(1)}'s meeting notes this week`;
            sections.push(`### ${label}\n${row.summary}`);
          }
        }
      }
      if (sections.length > 0) commsBlock = `\n\nCommunications context (Gmail + Granola):\n${sections.join('\n\n')}`;
    }

    const userMsg = `Company context:\n${JSON.stringify(businessContext, null, 2)}\n\nThis week's data:\n${JSON.stringify(businessData, null, 2)}${commsBlock}`;

    let memoText = '';
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model:      'claude-opus-4-5',  // Use Opus for the strategic memo — quality matters here
          max_tokens: 2000,
          system:     systemPrompt,
          messages:   [{ role: 'user', content: userMsg }],
        }),
      });
      if (r.ok) {
        const body = await r.json();
        memoText = (body.content || []).map((b: any) => b.text || '').join('').trim();
      }
    } catch (e) {
      memoText = `[Claude unavailable: ${(e as Error).message}]`;
    }

    // ── 4. Send email via Resend ───────────────────────────────────────────────
    let emailSent = false;
    let resendKey = Deno.env.get('RESEND_API_KEY');
    if (!resendKey) {
      const { data: kRow } = await db.from('vault.decrypted_secrets').select('decrypted_secret').eq('name', 'resend_api_key').single();
      resendKey = kRow?.decrypted_secret;
    }

    if (resendKey && memoText) {
      const htmlBody = memoText
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/^## ([A-Z &]+)$/gm, (_, h) => `</p><h2 style="font-size:13px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#d8b560;margin:28px 0 10px;padding-top:20px;border-top:1px solid #2a3a52;">${h}</h2><p style="margin:0;">`)
        .replace(/^- (.+)$/gm, '</p><li style="margin:6px 0;line-height:1.65;color:#d6d0c4;">$1</li><p style="margin:0;">')
        .replace(/\n\n/g, '</p><p style="margin:10px 0;">')
        .replace(/\n/g, '<br/>');

      const weekStr = now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

      const fullHtml = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"/></head>
<body style="margin:0;padding:0;background:#0b1222;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:660px;margin:0 auto;padding:28px 16px;">

    <!-- Header -->
    <div style="padding:28px 32px 24px;">
      <div style="font-size:10px;font-weight:800;letter-spacing:.18em;color:#d8b560;text-transform:uppercase;margin-bottom:8px;">Executive Business Summary</div>
      <div style="font-size:26px;font-weight:700;color:#fff;line-height:1.2;">Monday Memo<br/><span style="font-size:16px;font-weight:400;color:#8899aa;">${weekStr}</span></div>
      <div style="margin-top:16px;display:flex;gap:10px;flex-wrap:wrap;">
        <span style="background:rgba(216,181,96,0.15);border:1px solid rgba(216,181,96,0.3);border-radius:6px;padding:4px 10px;font-size:11px;color:#d8b560;">${allCommits.length} commits this week</span>
        <span style="background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:6px;padding:4px 10px;font-size:11px;color:#8899aa;">${(deals || []).length} active cases</span>
        <span style="background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:6px;padding:4px 10px;font-size:11px;color:#8899aa;">${msgSent} messages sent</span>
        ${(recentLeads || []).length > 0 ? `<span style="background:rgba(34,197,94,0.1);border:1px solid rgba(34,197,94,0.25);border-radius:6px;padding:4px 10px;font-size:11px;color:#86efac;">${(recentLeads || []).length} new leads</span>` : ''}
      </div>
    </div>

    <!-- Body -->
    <div style="background:#111827;border:1px solid #1f2d3d;border-radius:12px;padding:32px;margin:0 0 16px;">
      <div style="font-size:15px;line-height:1.7;color:#c9d0da;">
        <p style="margin:0 0 10px;">${htmlBody}</p>
      </div>
    </div>

    <!-- Footer -->
    <div style="padding:0 4px;">
      <p style="margin:0;font-size:11px;color:#4a5568;line-height:1.6;">
        Generated Sunday night by your AI product manager ·
        <a href="https://app.refundlocators.com/" style="color:#6b8cba;text-decoration:none;">Open DCC</a>
      </p>
    </div>

  </div>
</body>
</html>`;

      try {
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from:    FROM_EMAIL,
            to:      DIGEST_EMAILS,
            subject: `Monday Memo — ${weekStr}`,
            html:    fullHtml,
            text:    memoText,
          }),
        });
        emailSent = r.ok;
      } catch (_) { /* non-fatal */ }
    }

    return new Response(JSON.stringify({
      email_sent:     emailSent,
      commits_pulled: allCommits.length,
      active_deals:   (deals || []).length,
      new_leads:      (recentLeads || []).length,
      memo_preview:   memoText.slice(0, 400),
    }), { headers: { 'Content-Type': 'application/json' } });

  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
});
