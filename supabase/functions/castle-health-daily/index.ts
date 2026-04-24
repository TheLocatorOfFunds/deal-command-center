// castle-health-daily
//
// Scheduled "agent" that reviews Castle's scraper fleet once a day.
// Triggered by pg_cron at 13:00 UTC. Reads v_scraper_health, looks at the
// last 7 days of snapshots in castle_health_log to detect chronic vs
// transient issues, calls Claude for a human-readable summary + recommended
// actions, always logs a snapshot, and sends an email via Resend ONLY when
// there are issues worth surfacing.
//
// Severity triage (computed before Claude is called):
//   green     - all enabled agents green; no email
//   transient - 1+ yellow today, was green yesterday for same agent; low-priority email
//   chronic   - 1+ yellow today, also yellow 2+ of last 3 days; needs-attention email
//   critical  - 1+ red OR enabled-never_run agent; URGENT email
//
// Auth: shared-secret header check. pg_cron sets the header from Vault.
//
// Request: POST with header X-Castle-Health-Daily-Secret: <value>
// Response: { severity, agents: [...], email_sent, log_id }

import { createClient } from 'jsr:@supabase/supabase-js@2';

const FROM_EMAIL = 'RefundLocators <hello@refundlocators.com>';
const DEFAULT_RECIPIENT = 'nathan@fundlocators.com';

interface AgentRow {
  agent_id: string;
  display_name: string;
  cadence_minutes: number;
  grace_minutes: number;
  uses_selenium: boolean;
  county_scope: string | null;
  enabled: boolean;
  last_run_at: string | null;
  last_status: string | null;
  last_events_new: number | null;
  last_errors: any[] | null;
  age_minutes: number | null;
  fails_last_3h: number;
  health_color: 'green' | 'yellow' | 'red' | 'disabled' | 'never_run';
  should_alert: boolean;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });

  const secret = Deno.env.get('CASTLE_HEALTH_DAILY_SECRET');
  if (!secret) return json({ error: 'CASTLE_HEALTH_DAILY_SECRET not configured' }, 503);
  if (req.headers.get('X-Castle-Health-Daily-Secret') !== secret) return json({ error: 'Unauthorized' }, 401);

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
    const db = createClient(supabaseUrl, serviceKey);

    // 1. Today's snapshot
    const { data: agents, error: viewErr } = await db.from('v_scraper_health').select('*');
    if (viewErr) return json({ error: 'view_read_failed', details: viewErr.message }, 500);
    if (!agents || agents.length === 0) {
      return json({ severity: 'unknown', message: 'v_scraper_health returned 0 rows — Castle catalog empty?' }, 200);
    }

    // 2. Last 7 days of snapshots for chronic-vs-transient detection
    const since7 = new Date(Date.now() - 7 * 86400000).toISOString();
    const { data: history } = await db.from('castle_health_log')
      .select('snapshot_date, agents, severity')
      .gte('snapshot_at', since7)
      .order('snapshot_at', { ascending: false });

    // 3. Compute severity
    const severity = computeSeverity(agents as AgentRow[], history || []);

    // 4. Recipient from env var (settable in Edge Function Secrets without redeploy)
    const recipient = Deno.env.get('CASTLE_HEALTH_RECIPIENT') || DEFAULT_RECIPIENT;

    // 5. Get Claude's summary if there's something to summarize
    let summary = '';
    let recommendations: any = { actions: [], priority: 'low' };
    if (severity !== 'green' && anthropicKey) {
      const ai = await callClaude(anthropicKey, agents as AgentRow[], history || [], severity);
      summary = ai.summary;
      recommendations = ai.recommendations;
    } else if (severity === 'green') {
      summary = `All ${agents.length} Castle agents healthy. Last run ages: ${agents.map((a: any) => `${a.agent_id}=${fmtAge(a.age_minutes)}`).join(', ')}.`;
    }

    // 6. Always log the snapshot
    const { data: log, error: logErr } = await db.from('castle_health_log').insert({
      agents,
      any_issues: severity !== 'green',
      severity,
      summary,
      recommendations,
      email_recipient: severity === 'green' ? null : recipient,
    }).select('id').single();
    if (logErr) return json({ error: 'log_insert_failed', details: logErr.message }, 500);

    // 7. Email only on issues
    let emailSent = false;
    if (severity !== 'green') {
      emailSent = await sendEmail(recipient, agents as AgentRow[], severity, summary, recommendations);
      if (emailSent) {
        await db.from('castle_health_log').update({ email_sent: true }).eq('id', log.id);
      }
    }

    return json({
      severity,
      agents_checked: agents.length,
      issues_found: agents.filter((a: any) => a.health_color !== 'green' && a.health_color !== 'disabled').map((a: any) => ({ agent: a.agent_id, color: a.health_color, age_min: a.age_minutes })),
      email_sent: emailSent,
      log_id: log.id,
      recipient: severity === 'green' ? null : recipient,
    });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});

// ─── Severity logic ────────────────────────────────────────
// green:     every enabled agent is green
// transient: yellow today, was green most of last 3 days for same agent
// chronic:   yellow today AND yellow 2+ of last 3 days for same agent
// critical:  red OR enabled-never_run

function computeSeverity(agents: AgentRow[], history: any[]): 'green' | 'transient' | 'chronic' | 'critical' {
  const enabled = agents.filter(a => a.enabled);

  if (enabled.some(a => a.health_color === 'red')) return 'critical';
  if (enabled.some(a => a.health_color === 'never_run')) return 'critical';

  const yellowToday = enabled.filter(a => a.health_color === 'yellow');
  if (yellowToday.length === 0) return 'green';

  // For each yellow-today agent, was it yellow on 2+ of last 3 days?
  const recent3 = (history || []).slice(0, 3);
  const isChronic = yellowToday.some(today => {
    let yellowDays = 0;
    for (const snap of recent3) {
      const matchingAgent = (snap.agents as any[]).find((a: any) => a.agent_id === today.agent_id);
      if (matchingAgent && (matchingAgent.health_color === 'yellow' || matchingAgent.health_color === 'red')) {
        yellowDays++;
      }
    }
    return yellowDays >= 2;
  });

  return isChronic ? 'chronic' : 'transient';
}

// ─── Claude call for the human summary ─────────────────────

async function callClaude(apiKey: string, agents: AgentRow[], history: any[], severity: string) {
  const recent3 = (history || []).slice(0, 3).map((h: any) => ({
    date: h.snapshot_date,
    severity: h.severity,
    yellow_or_red_agents: (h.agents as any[]).filter(a => ['yellow', 'red'].includes(a.health_color)).map(a => ({ agent_id: a.agent_id, color: a.health_color, age_min: Math.round(a.age_minutes || 0) })),
  }));

  const systemPrompt = `You are the Castle ops health agent. Once a day you review the scraper fleet
for RefundLocators (Ohio surplus-fund cases). Castle is 5 agents:
- main: Hamilton + Franklin docket monitor (httpx, every 30 min)
- butler: Butler county docket monitor (Selenium CourtView 3, every 30 min)
- cuyahoga: Cuyahoga county docket monitor (Selenium PROWARE, every 30 min)
- montgomery: Montgomery county docket monitor (Selenium PROWARE + reCAPTCHA, every 30 min)
- court_pull: on-demand poller for the court_pull_requests queue (every 30 min)

You receive today's v_scraper_health snapshot plus the last 3 days of history.
Today's severity has already been computed by deterministic code. Your job is to
write the human prose:

1. A 1-2 sentence summary of what's wrong (or what changed from yesterday)
2. A list of recommended actions, each with priority: 'high' | 'med' | 'low'

Do NOT write meta-commentary, do NOT hedge, do NOT use "I believe". Be concrete.
Reference specific agent_ids. If court_pull is the issue, mention that's the
on-demand queue consumer (separate from the county monitors). Recommended
actions should map to real ops moves: "restart the daemon on the Mac Mini",
"check ~/Documents/Claude/refundlocators-pipeline/HANDOFF.md",
"investigate Selenium driver crash", "build the Hamilton scraper".

Return JSON only: {"summary": "...", "recommendations": [{"action": "...", "priority": "high|med|low"}, ...]}`;

  const userMsg = `Severity: ${severity}

Today's agents:
${JSON.stringify(agents.map(a => ({
    agent_id: a.agent_id,
    health_color: a.health_color,
    last_status: a.last_status,
    age_minutes: Math.round(a.age_minutes || 0),
    fails_last_3h: a.fails_last_3h,
    enabled: a.enabled,
    cadence_minutes: a.cadence_minutes,
    grace_minutes: a.grace_minutes,
  })), null, 2)}

Last 3 days of snapshots:
${JSON.stringify(recent3, null, 2)}`;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 800,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMsg }],
      }),
    });
    if (!resp.ok) {
      return { summary: `(Claude call failed: HTTP ${resp.status}) Severity: ${severity}.`, recommendations: { actions: [], priority: 'low' } };
    }
    const body = await resp.json();
    const text = (body.content || []).map((b: any) => b.text || '').join('').trim();
    // Extract JSON — Claude may wrap in ```json fences
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { summary: text, recommendations: { actions: [], priority: 'med' } };
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      summary: parsed.summary || '',
      recommendations: { actions: parsed.recommendations || [], priority: parsed.recommendations?.[0]?.priority || 'med' },
    };
  } catch (e) {
    return { summary: `(Claude exception: ${(e as Error).message})`, recommendations: { actions: [], priority: 'low' } };
  }
}

// ─── Email via Resend ──────────────────────────────────────

async function sendEmail(to: string, agents: AgentRow[], severity: string, summary: string, recommendations: any): Promise<boolean> {
  const resendKey = Deno.env.get('RESEND_API_KEY');
  if (!resendKey) return false;

  const emoji = severity === 'critical' ? '🔴' : severity === 'chronic' ? '🟡' : '⚠';
  const issuesNoun = severity === 'critical' ? 'agents down' : severity === 'chronic' ? 'agents stale' : 'transient stall';

  const issueAgents = agents.filter(a => a.health_color !== 'green' && a.health_color !== 'disabled');
  const subject = `${emoji} Castle health · ${issueAgents.length} ${issuesNoun} · ${severity}`;

  const rows = agents.map(a => {
    const dot = ({
      green: '🟢', yellow: '🟡', red: '🔴', disabled: '⏸', never_run: '🚫',
    } as Record<string, string>)[a.health_color] || '⚪';
    const ageStr = fmtAge(a.age_minutes);
    return `<tr>
      <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb;">${dot} <b>${escapeHtml(a.display_name)}</b><br/><span style="color:#6b7280; font-size: 12px; font-family: monospace;">${a.agent_id}</span></td>
      <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb; color:#6b7280;">${escapeHtml(a.county_scope || '—')}</td>
      <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb; text-align: right; font-family: monospace;">${ageStr}</td>
      <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb;">${escapeHtml(a.last_status || '—')}</td>
      <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb; text-align: right; color: ${a.fails_last_3h > 0 ? '#dc2626' : '#9ca3af'}; font-weight: ${a.fails_last_3h > 0 ? 'bold' : 'normal'}; font-family: monospace;">${a.fails_last_3h}</td>
    </tr>`;
  }).join('');

  const recsHtml = (recommendations.actions || []).map((r: any) => {
    const pColor = r.priority === 'high' ? '#dc2626' : r.priority === 'med' ? '#d97706' : '#6b7280';
    return `<li style="margin-bottom: 8px;"><span style="background:${pColor}; color:white; padding:2px 8px; border-radius:4px; font-size:11px; font-weight: bold; text-transform: uppercase;">${escapeHtml(r.priority || 'med')}</span> ${escapeHtml(r.action || '')}</li>`;
  }).join('');

  const html = `<!DOCTYPE html><html><body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; color:#111827; max-width: 640px; margin: 0 auto; padding: 24px;">
    <div style="background:#0b1f3a; color:#fffcf5; padding: 20px 24px; border-radius: 8px 8px 0 0;">
      <div style="font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; opacity: 0.7;">Castle Health · Daily Snapshot</div>
      <div style="font-size: 22px; margin-top: 6px; font-weight: 600;">${emoji} ${escapeHtml(severity.toUpperCase())} · ${issueAgents.length} ${issuesNoun}</div>
      <div style="font-size: 13px; margin-top: 8px; opacity: 0.8;">${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</div>
    </div>
    <div style="background:white; border: 1px solid #e5e7eb; border-top: none; padding: 24px; border-radius: 0 0 8px 8px;">
      <p style="font-size: 14px; line-height: 1.6; margin: 0 0 18px;">${escapeHtml(summary)}</p>
      <h3 style="font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: #6b7280; margin: 0 0 8px;">Agent fleet</h3>
      <table style="width:100%; border-collapse: collapse; font-size: 13px;">
        <thead><tr style="background:#f9fafb;">
          <th style="padding: 8px 12px; text-align: left; font-size: 11px; color:#6b7280; letter-spacing:0.06em; text-transform: uppercase;">Agent</th>
          <th style="padding: 8px 12px; text-align: left; font-size: 11px; color:#6b7280; letter-spacing:0.06em; text-transform: uppercase;">Scope</th>
          <th style="padding: 8px 12px; text-align: right; font-size: 11px; color:#6b7280; letter-spacing:0.06em; text-transform: uppercase;">Last run</th>
          <th style="padding: 8px 12px; text-align: left; font-size: 11px; color:#6b7280; letter-spacing:0.06em; text-transform: uppercase;">Status</th>
          <th style="padding: 8px 12px; text-align: right; font-size: 11px; color:#6b7280; letter-spacing:0.06em; text-transform: uppercase;">Fails 3h</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${recsHtml ? `<h3 style="font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: #6b7280; margin: 24px 0 8px;">Recommended actions</h3><ul style="font-size: 13px; line-height: 1.6; padding-left: 20px;">${recsHtml}</ul>` : ''}
      <p style="font-size: 11px; color: #9ca3af; margin: 24px 0 0; line-height: 1.5;">
        From Castle Health Daily · runs at 13:00 UTC every day. Routes here from <code>vault.castle_health_recipient_email</code> · DCC also has a live view at the Reports tab. Silent on green days.
      </p>
    </div>
  </body></html>`;

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [to],
        subject,
        html,
      }),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

// ─── helpers ───────────────────────────────────────────────

function fmtAge(m: number | null): string {
  if (m == null) return '—';
  if (m < 1) return 'just now';
  if (m < 60) return Math.round(m) + 'm';
  if (m < 1440) return (m / 60).toFixed(1) + 'h';
  return Math.round(m / 1440) + 'd';
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string));
}

function json(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
