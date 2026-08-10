// monday-memo — AI Business Advisor Weekly Briefing
//
// Runs Sunday at 07:00 UTC (3am EDT) via pg_cron.
// Sends Monday morning to Nathan from hello@fundlocators.com.
// 2026-08-10: Justin removed from recipients + prompt (separation decoupling).
// NOTE: this file is the deployed v55 "AI Business Advisor" rewrite, synced
// back into the repo 2026-08-10 — the repo had a stale 319-line version.
//
// Acts as an AI business advisor for the whole company:
//   - Pulls GitHub commits from the past 7 days across all repos
//   - Pulls DCC live data (deals, outreach pipeline, leads)
//   - Reads team_communications table (Gmail + Granola summaries)
//   - Claude synthesizes: what shipped, what's working, what's not,
//     relevant AI/tech developments, the blind spot, the one move to make
//
// Sections: THREE NUMBERS · WHAT SHIPPED · WHAT YOU'RE DOING WELL ·
//           WATCH LIST · AI & TECH THIS WEEK ·
//           WHAT YOU'RE NOT THINKING ABOUT · THIS WEEK'S MOVE
//
// Auth: POST with X-Monday-Memo-Secret header
// Schedule: 0 7 * * 0 (Sunday 7am UTC)

import { createClient } from 'jsr:@supabase/supabase-js@2';

const DIGEST_EMAILS = ['nathan@fundlocators.com'];
const FROM_EMAIL    = 'RefundLocators <hello@fundlocators.com>';

const GITHUB_REPOS = [
  'TheLocatorOfFunds/deal-command-center',
];

// Section numbers and subtitles for Fraunces italic display line
const SECTION_META: Record<string, { num: string; subtitle: string }> = {
  'THREE NUMBERS':                  { num: '01', subtitle: 'The week in three numbers.'        },
  'WHAT SHIPPED':                   { num: '02', subtitle: 'Infrastructure you can use today.' },
  "WHAT YOU'RE DOING WELL":         { num: '03', subtitle: 'Discipline that compounds.'        },
  'WATCH LIST':                     { num: '04', subtitle: 'Things that could quietly hurt you.' },
  'AI & TECH THIS WEEK':            { num: '05', subtitle: 'Tools worth knowing about.'        },
  "WHAT YOU'RE NOT THINKING ABOUT": { num: '06', subtitle: 'Blind spots worth naming.'         },
  "THIS WEEK'S MOVE":               { num: '07', subtitle: 'The one move that matters.'        },
};

// ─── HTML email builder ───────────────────────────────────────────────────────
function buildEmailHtml(opts: {
  weekStr:        string;
  dealsCount:     number;
  commitsCount:   number;
  msgSent:        number;
  newLeads:       number;
  memoText:       string;
}): string {
  const { weekStr, dealsCount, commitsCount, msgSent, newLeads, memoText } = opts;

  // Parse memoText into sections (split on "## " at start of line)
  const rawParts = memoText.split(/\n(?=## )/);
  const parsedSections: Array<{ name: string; highlight: boolean; content: string }> = [];

  for (const part of rawParts) {
    const lines = part.trim().split('\n');
    const firstLine = lines[0].trim();
    if (firstLine.startsWith('## ')) {
      const name    = firstLine.replace(/^## /, '').trim();
      const content = lines.slice(1).join('\n').trim();
      const highlight = name === "THIS WEEK'S MOVE";
      parsedSections.push({ name, highlight, content });
    }
  }

  const sectionsHtml = parsedSections.length > 0
    ? parsedSections.map((s, i) => renderSection(s, i)).join('\n')
    : renderFallback(memoText);

  const newLeadsCardBg     = newLeads > 0 ? '#1e1810' : '#181410';
  const newLeadsBorder     = newLeads > 0 ? 'rgba(201,162,74,0.38)' : 'rgba(255,240,200,0.07)';
  const newLeadsLabelColor = newLeads > 0 ? 'rgba(201,162,74,0.55)' : 'rgba(240,236,228,0.28)';
  const newLeadsNumColor   = newLeads > 0 ? '#c9a24a' : '#f0ece4';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <meta name="color-scheme" content="dark"/>
  <!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300;0,9..144,400;1,9..144,300;1,9..144,400&family=Inter:wght@200;300;400;500;600;700&family=JetBrains+Mono:wght@400;700&display=swap');
    body { margin:0; padding:0; background:#0c0a07; -webkit-text-size-adjust:100%; }
    a { color:#c9a24a; text-decoration:none; }
  </style>
</head>
<body style="margin:0;padding:0;background:#0c0a07;font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;">

<table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#0c0a07" style="background:#0c0a07;">
<tr><td align="center" style="padding:52px 16px 72px;">
<table width="580" cellpadding="0" cellspacing="0" border="0" style="max-width:580px;width:100%;">

  <!-- TOP BAR -->
  <tr><td style="padding:0 0 44px 0;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td><span style="font-family:'Inter',-apple-system,sans-serif;font-size:10px;font-weight:600;letter-spacing:0.22em;text-transform:uppercase;color:rgba(240,236,228,0.28);">RefundLocators</span></td>
      <td align="right"><span style="font-family:'Inter',-apple-system,sans-serif;font-size:10px;font-weight:400;letter-spacing:0.04em;color:rgba(240,236,228,0.2);">${escHtml(weekStr)}</span></td>
    </tr></table>
  </td></tr>

  <!-- TITLE: MONDAY (thin Inter) + Memo. (Fraunces italic gold) -->
  <tr><td style="padding:0 0 4px 0;">
    <div style="font-family:'Inter',-apple-system,sans-serif;font-size:13px;font-weight:200;color:rgba(240,236,228,0.42);line-height:1.0;letter-spacing:0.22em;text-transform:uppercase;">Monday</div>
  </td></tr>
  <tr><td style="padding:0 0 52px 0;">
    <div style="font-family:'Fraunces','Georgia',serif;font-size:56px;font-weight:400;font-style:italic;color:#c9a24a;line-height:1.05;letter-spacing:-0.02em;">Memo.</div>
  </td></tr>

  <!-- STAT CARDS -->
  <tr><td style="padding:0 0 60px 0;">
    <table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
      <td style="padding:0 5px 0 0;" width="25%">
        <table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
          <td style="background:#181410;border:1px solid rgba(255,240,200,0.07);border-radius:14px;padding:18px 20px;">
            <div style="font-family:'Inter',sans-serif;font-size:9px;font-weight:600;letter-spacing:0.18em;text-transform:uppercase;color:rgba(240,236,228,0.28);margin-bottom:10px;">Cases</div>
            <div style="font-family:'JetBrains Mono','Courier New',monospace;font-size:28px;font-weight:700;color:#f0ece4;line-height:1;">${dealsCount}</div>
          </td>
        </tr></table>
      </td>
      <td style="padding:0 5px;" width="25%">
        <table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
          <td style="background:#181410;border:1px solid rgba(255,240,200,0.07);border-radius:14px;padding:18px 20px;">
            <div style="font-family:'Inter',sans-serif;font-size:9px;font-weight:600;letter-spacing:0.18em;text-transform:uppercase;color:rgba(240,236,228,0.28);margin-bottom:10px;">Commits</div>
            <div style="font-family:'JetBrains Mono','Courier New',monospace;font-size:28px;font-weight:700;color:#f0ece4;line-height:1;">${commitsCount}</div>
          </td>
        </tr></table>
      </td>
      <td style="padding:0 5px;" width="25%">
        <table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
          <td style="background:#181410;border:1px solid rgba(255,240,200,0.07);border-radius:14px;padding:18px 20px;">
            <div style="font-family:'Inter',sans-serif;font-size:9px;font-weight:600;letter-spacing:0.18em;text-transform:uppercase;color:rgba(240,236,228,0.28);margin-bottom:10px;">Messages</div>
            <div style="font-family:'JetBrains Mono','Courier New',monospace;font-size:28px;font-weight:700;color:#f0ece4;line-height:1;">${msgSent}</div>
          </td>
        </tr></table>
      </td>
      <td style="padding:0 0 0 5px;" width="25%">
        <table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
          <td style="background:${newLeadsCardBg};border:1px solid ${newLeadsBorder};border-radius:14px;padding:18px 20px;">
            <div style="font-family:'Inter',sans-serif;font-size:9px;font-weight:600;letter-spacing:0.18em;text-transform:uppercase;color:${newLeadsLabelColor};margin-bottom:10px;">New Leads</div>
            <div style="font-family:'JetBrains Mono','Courier New',monospace;font-size:28px;font-weight:700;color:${newLeadsNumColor};line-height:1;">${newLeads}</div>
          </td>
        </tr></table>
      </td>
    </tr></table>
  </td></tr>

  ${sectionsHtml}

  <!-- FOOTER -->
  <tr><td style="padding:0;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td><span style="font-family:'Inter',sans-serif;font-size:10px;letter-spacing:0.04em;color:rgba(240,236,228,0.16);">Weekly AI briefing for RefundLocators</span></td>
      <td align="right"><a href="https://thelocatoroffunds.github.io/deal-command-center/" style="font-family:'Inter',sans-serif;font-size:10px;font-weight:600;letter-spacing:0.06em;color:rgba(201,162,74,0.4);text-decoration:none;text-transform:uppercase;">Open DCC &rarr;</a></td>
    </tr></table>
  </td></tr>

</table>
</td></tr>
</table>

</body>
</html>`;
}

function renderSection(
  s: { name: string; highlight: boolean; content: string },
  index: number
): string {
  const meta     = SECTION_META[s.name] || { num: '—', subtitle: '' };
  const html     = markdownToEmailHtml(s.content);
  const topPad   = index === 0 ? '0' : '52px';

  if (s.highlight) {
    // Featured card — gold border + gradient bg
    return `
  <!-- ── ${escHtml(s.name)} (featured) ── -->
  <tr><td style="padding:${topPad} 0 60px 0;">
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#1a140b;border:1px solid rgba(201,162,74,0.38);border-radius:20px;">
      <tr><td style="padding:36px 40px;">
        <div style="font-family:'Inter',sans-serif;font-size:9px;font-weight:600;letter-spacing:0.2em;text-transform:uppercase;color:rgba(201,162,74,0.55);margin-bottom:10px;">${escHtml(meta.num)} &nbsp;/&nbsp; ${escHtml(s.name)}</div>
        <div style="font-family:'Fraunces','Georgia',serif;font-size:32px;font-weight:400;font-style:italic;color:#e0bb6a;line-height:1.1;margin-bottom:20px;">${escHtml(meta.subtitle)}</div>
        <div style="font-family:'Inter',sans-serif;font-size:15px;line-height:1.9;color:rgba(240,236,228,0.78);">${html}</div>
      </td></tr>
    </table>
  </td></tr>`;
  }

  return `
  <!-- ── ${escHtml(s.name)} ── -->
  <tr><td style="padding:${topPad} 0 10px 0;">
    <div style="font-family:'Inter',sans-serif;font-size:9px;font-weight:600;letter-spacing:0.2em;text-transform:uppercase;color:rgba(201,162,74,0.5);">${escHtml(meta.num)} &nbsp;/&nbsp; ${escHtml(s.name)}</div>
  </td></tr>
  <tr><td style="padding:0 0 10px 0;">
    <div style="font-family:'Fraunces','Georgia',serif;font-size:28px;font-weight:400;font-style:italic;color:#f0ece4;line-height:1.1;">${escHtml(meta.subtitle)}</div>
  </td></tr>
  <tr><td style="padding:0 0 24px 0;">
    <div style="height:1px;background:rgba(201,162,74,0.25);"></div>
  </td></tr>
  <tr><td style="padding:0 0 52px 0;">
    <div style="font-family:'Inter',sans-serif;font-size:15px;line-height:1.9;color:rgba(240,236,228,0.65);">${html}</div>
  </td></tr>`;
}

function renderFallback(text: string): string {
  return `
  <tr><td style="padding:0 0 60px 0;">
    <div style="font-family:'Inter',sans-serif;font-size:15px;line-height:1.9;color:rgba(240,236,228,0.65);">${markdownToEmailHtml(text)}</div>
  </td></tr>`;
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function markdownToEmailHtml(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let inPara = false;

  for (const raw of lines) {
    const line = raw.trim();

    if (line === '') {
      if (inPara) { out.push('</p>'); inPara = false; }
      continue;
    }

    if (line.startsWith('- ') || line.startsWith('* ')) {
      if (inPara) { out.push('</p>'); inPara = false; }
      const inner = inlineMarkdown(line.slice(2));
      out.push(`<p style="margin:0 0 12px 0;padding-left:18px;text-indent:-14px;"><span style="color:#c9a24a;margin-right:8px;">&mdash;</span>${inner}</p>`);
      continue;
    }

    if (/^\d+\. /.test(line)) {
      if (inPara) { out.push('</p>'); inPara = false; }
      const num   = line.match(/^(\d+)\. /)?.[1] || '';
      const inner = inlineMarkdown(line.replace(/^\d+\. /, ''));
      out.push(`<p style="margin:0 0 12px 0;padding-left:22px;text-indent:-16px;"><span style="color:#c9a24a;font-family:'JetBrains Mono',monospace;font-size:12px;margin-right:6px;">${escHtml(num)}.</span>${inner}</p>`);
      continue;
    }

    const inner = inlineMarkdown(line);
    if (!inPara) { out.push('<p style="margin:0 0 16px 0;">'); inPara = true; }
    else out.push(' ');
    out.push(inner);
  }

  if (inPara) out.push('</p>');
  return out.join('');
}

function inlineMarkdown(text: string): string {
  return escHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong style="color:#f0ece4;font-weight:600;">$1</strong>')
    .replace(/\*(.+?)\*/g,     '<em style="color:#e0bb6a;font-style:italic;">$1</em>')
    .replace(/`(.+?)`/g,       '<code style="font-family:\'JetBrains Mono\',\'Courier New\',monospace;font-size:12px;background:rgba(255,255,255,0.07);padding:2px 7px;border-radius:4px;color:#f0ece4;">$1</code>')
    .replace(/↑/g, '<span style="color:#c9a24a;">↑</span>')
    .replace(/↓/g, '<span style="color:#ef4444;">↓</span>');
}

// ─── Edge function handler ────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });

  const secret = Deno.env.get('MONDAY_MEMO_SECRET');
  if (!secret)
    return new Response(JSON.stringify({ error: 'MONDAY_MEMO_SECRET not configured' }), {
      status: 503, headers: { 'Content-Type': 'application/json' },
    });
  if (req.headers.get('X-Monday-Memo-Secret') !== secret)
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    });

  try {
    const supabaseUrl  = Deno.env.get('SUPABASE_URL')!;
    const serviceKey   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY')!;
    const githubToken  = Deno.env.get('GITHUB_TOKEN');
    const db           = createClient(supabaseUrl, serviceKey);

    const now        = new Date();
    const weekAgoIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const weekStr    = now.toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    });

    const ghHeaders: Record<string, string> = {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (githubToken) ghHeaders['Authorization'] = `Bearer ${githubToken}`;

    // ── 1. GitHub commits ─────────────────────────────────────────────────────
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
      } catch (_) { /* skip unreachable repos */ }
    }

    // ── 2. DCC live data ──────────────────────────────────────────────────────
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
      db.from('team_communications')
        .select('person, source, summary')
        .gte('week_of', weekAgoIso.split('T')[0]),
    ]);

    const outreachByStatus: Record<string, number> = {};
    (outreachStats || []).forEach((r: any) => {
      outreachByStatus[r.status] = (outreachByStatus[r.status] || 0) + 1;
    });

    const msgSent     = (recentMessages || []).filter((m: any) => m.direction === 'outbound').length;
    const msgReceived = (recentMessages || []).filter((m: any) => m.direction === 'inbound').length;
    const dealsByStatus: Record<string, number> = {};
    (deals || []).forEach((d: any) => { dealsByStatus[d.status] = (dealsByStatus[d.status] || 0) + 1; });

    // ── 3. Claude: AI business advisor memo ───────────────────────────────────
    const systemPrompt = `You are an AI business advisor for RefundLocators, a surplus fund recovery firm. Nathan is the founder and sole operator — he runs sales, operations, and the product with AI-agent help and a couple of contractors. Every week you send him a Monday morning briefing that acts as a smart COO looking over his shoulder.

WHAT YOU DO NOT DO:
- No client case summaries or case-by-case updates
- No meeting recaps
- No generic advice ("grow your pipeline", "stay focused")
- No filler sections — if there's nothing notable in a section, say so in one honest sentence

TONE: Direct, confident, specific. You have opinions. You tell them what matters, what to ignore, and what to do. Write like a smart person talking to two smart founders. No hedge words ("it appears", "you might consider").

---

OUTPUT — write exactly these 7 sections in this order, using ## for headers:

## THREE NUMBERS
Three metrics that define this week. Each on its own line:
**[Metric]**: [value] — [one-sentence interpretation]
Pick the three numbers that tell the real story: not always the obvious ones. Include direction (↑/↓) when comparing to trend.

## WHAT SHIPPED
Translate GitHub commits into plain English. Group by system (DCC, Castle, Ohio Intel, Website). Skip trivial commits (merges, typos, dependency bumps). Focus on capabilities that changed what the business can do. If commits are sparse, say so in one sentence.

## WHAT YOU'RE DOING WELL
2-3 specific things that are working. Not compliments — observations that explain WHY something is working so they keep doing it. Ground in the actual data.

## WATCH LIST
1-3 things that are trending wrong or need a decision. Anomaly-only — don't list things that are normal. Each item: what it is, why it matters, what would make it go away. If nothing is on the watch list, say "Nothing critical this week."

## AI & TECH THIS WEEK
3-4 specific tools, models, or developments relevant to RefundLocators right now. For each:
- **[Tool/Model]**: what it is + why it matters to this specific business (skip-tracing, outreach, court records, lead gen, automation)
- How you'd actually use it (be specific, not vague)

Focus on: new AI model capabilities, outreach/voice/SMS tools, property/court data providers, anything that could replace current vendors (BatchData, BrightData, GoHighLevel, Drop Cowboy).

## WHAT YOU'RE NOT THINKING ABOUT
1-2 things that aren't on their radar but should be. This is the blind-spot section — surfacing risks, opportunities, or strategic moves they haven't considered. Be specific and direct.

## THIS WEEK'S MOVE
One thing. The highest-leverage action they should take before next Monday. Not a project — a specific action with a clear outcome. State it as a directive: "Do X because Y." Make it actionable in hours, not days.

---

Hard rules:
- Total length: 550–750 words across all sections
- Every number must be real (from the data provided)
- "THIS WEEK'S MOVE" gets one paragraph max — it should be the most memorable thing in the email`;

    // Build comms context block
    let commsBlock = '';
    if (teamComms && teamComms.length > 0) {
      const parts: string[] = [];
      for (const source of ['gmail', 'granola']) {
        for (const person of ['nathan', 'team']) {
          const row = (teamComms as any[]).find(r => r.source === source && r.person === person);
          if (row?.summary) {
            const label = source === 'gmail'
              ? `${person.charAt(0).toUpperCase() + person.slice(1)}'s emails this week`
              : `${person.charAt(0).toUpperCase() + person.slice(1)}'s meeting notes this week`;
            parts.push(`### ${label}\n${row.summary}`);
          }
        }
      }
      if (parts.length > 0) commsBlock = `\n\nCommunications (Gmail + meeting notes):\n${parts.join('\n\n')}`;
    }

    const businessContext = {
      company:    'RefundLocators — surplus fund recovery firm. Find homeowners owed money from foreclosure auctions, sign them as clients, recover funds through the court system.',
      team:       'Nathan (founder, sole operator) + contractor callers/VAs. AI agents handle engineering and research.',
      tech_stack: 'GoHighLevel — CRM (the working surface; the DCC app is sunsetting). Supabase — intel engine, docket spine, document store, measurement warehouse. Castle / Ohio Intel — court scrapers + enrichment feeding verified leads. refundlocators.com — public site + personalized landing pages. Resend — transactional email. Twilio — voice/SMS until the GHL port completes.',
    };

    const businessData = {
      week_ending:                weekStr,
      github_commits_this_week:   allCommits.length,
      commits:                    allCommits.slice(0, 40),
      active_deals:               (deals || []).length,
      deal_pipeline:              dealsByStatus,
      new_leads_this_week:        (recentLeads || []).length,
      outreach_funnel_this_week:  outreachByStatus,
      messages_sent_this_week:    msgSent,
      messages_received_this_week: msgReceived,
      notable_activity:           (recentActivity || []).slice(0, 20).map((a: any) => a.action),
    };

    const userMsg = `Business context:\n${JSON.stringify(businessContext, null, 2)}\n\nThis week's data:\n${JSON.stringify(businessData, null, 2)}${commsBlock}`;

    let memoText = '';
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method:  'POST',
        headers: {
          'x-api-key':         anthropicKey,
          'anthropic-version': '2023-06-01',
          'Content-Type':      'application/json',
        },
        body: JSON.stringify({
          model:      'claude-opus-4-5',
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
    let emailSent  = false;
    let resendError = '';
    let resendKey   = Deno.env.get('RESEND_API_KEY');
    if (!resendKey) {
      const { data: kRow } = await db
        .from('vault.decrypted_secrets')
        .select('decrypted_secret')
        .eq('name', 'resend_api_key')
        .single();
      resendKey = kRow?.decrypted_secret;
    }

    if (resendKey && memoText) {
      const htmlBody = buildEmailHtml({
        weekStr,
        dealsCount:   (deals || []).length,
        commitsCount: allCommits.length,
        msgSent,
        newLeads:     (recentLeads || []).length,
        memoText,
      });

      try {
        const r = await fetch('https://api.resend.com/emails', {
          method:  'POST',
          headers: {
            'Authorization': `Bearer ${resendKey}`,
            'Content-Type':  'application/json',
          },
          body: JSON.stringify({
            from:    FROM_EMAIL,
            to:      DIGEST_EMAILS,
            subject: `Monday Memo — ${weekStr}`,
            html:    htmlBody,
            text:    memoText,
          }),
        });
        emailSent = r.ok;
        if (!r.ok) resendError = await r.text();
      } catch (e) { resendError = (e as Error).message; }
    }

    return new Response(JSON.stringify({
      email_sent:     emailSent,
      resend_error:   resendError || undefined,
      commits_pulled: allCommits.length,
      active_deals:   (deals || []).length,
      new_leads:      (recentLeads || []).length,
      memo_preview:   memoText.slice(0, 400),
    }), { headers: { 'Content-Type': 'application/json' } });

  } catch (e) {
    return new Response(
      JSON.stringify({ error: (e as Error).message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
});
