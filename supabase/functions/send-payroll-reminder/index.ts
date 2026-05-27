// send-payroll-reminder
//
// Called by pg_cron via send_payroll_reminder() SQL function whenever
// there is outstanding payroll at 9am ET or 4pm ET. Fans out a Resend
// email + Twilio SMS to Justin with the per-VA breakdown.
//
// Per Justin, 2026-05-26: refire every day at 9am + 4pm ET, just him,
// title format "Payroll due and how much is due to each person."
// Auto-silences when every VA with hours has a matching `payments` row
// for the current period (i.e., the "Mark Paid" button in the Time tab
// was clicked).
//
// Auth: the SQL caller passes X-Payroll-Reminder-Secret (read from Vault).
// We verify it server-side via the verify_payroll_reminder_secret() RPC —
// the secret never needs to be set as a function env var. We then recompute
// the payroll summary fresh via the payroll_due_summary() RPC (don't trust
// any POSTed body).
//
// Env (all already set project-wide — nothing new to configure):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — auto-injected
//   RESEND_API_KEY          — Resend (already used by morning-sweep)
//   TWILIO_ACCOUNT_SID      — Twilio (already used by submit-lead etc.)
//   TWILIO_AUTH_TOKEN
//   TWILIO_FROM_NUMBER      — +15139985440 (A2P-verified)

import { createClient } from 'jsr:@supabase/supabase-js@2';

const RECIPIENT_EMAIL = 'justin@fundlocators.com';
const RECIPIENT_PHONE = '+14797196859';            // Justin's cell
const FROM_EMAIL      = 'FundLocators <hello@fundlocators.com>';  // internal exec mail
const APP_URL         = 'https://app.refundlocators.com/#/view/time';

type Person = {
  user_id: string;
  name: string;
  hours: number;
  rate: number | null;
  amount: number;
};

type Period = {
  period_start: string;
  period_end: string;
  pay_date: string;
  days_overdue: number;
  period_total: number;
  people: Person[];
};

type Summary = {
  is_due: boolean;
  as_of_date: string;
  grand_total: number;
  periods: Period[];
};

const money = (n: number) =>
  '$' + Number(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

const fmtDate = (iso: string) => {
  const d = new Date(iso + 'T12:00:00Z');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
};

const buildSubject = (s: Summary) => {
  // "Payroll due and how much is due to each person" — Justin's wording, compressed
  const top = s.periods[0]?.people?.[0];
  if (s.periods.length === 1 && s.periods[0].people.length === 1) {
    return `💵 Payroll due — ${money(s.grand_total)} (${top?.name})`;
  }
  const names = s.periods[0]?.people.map(p => `${money(p.amount)} ${p.name}`).join(', ');
  return `💵 Payroll due — ${money(s.grand_total)} total${names ? ` (${names})` : ''}`;
};

const buildEmailHtml = (s: Summary) => {
  const periodBlocks = s.periods.map(p => `
    <tr><td style="padding:12px 0;border-bottom:1px solid #e5e7eb;">
      <div style="font-size:14px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">
        Pay period ${fmtDate(p.period_start)} – ${fmtDate(p.period_end)}
      </div>
      <div style="font-size:13px;color:#6b7280;margin-top:4px;">
        Pay date ${fmtDate(p.pay_date)}${p.days_overdue > 0 ? ` · <span style="color:#dc2626;font-weight:600;">${p.days_overdue} ${p.days_overdue === 1 ? 'day' : 'days'} overdue</span>` : ''}
      </div>
      <table style="margin-top:12px;width:100%;border-collapse:collapse;font-size:14px;">
        <thead>
          <tr style="text-align:left;color:#9ca3af;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;">
            <th style="padding:6px 0;font-weight:600;">Person</th>
            <th style="padding:6px 0;font-weight:600;text-align:right;">Hours</th>
            <th style="padding:6px 0;font-weight:600;text-align:right;">Rate</th>
            <th style="padding:6px 0;font-weight:600;text-align:right;">Amount</th>
          </tr>
        </thead>
        <tbody>
          ${p.people.map(pp => `
            <tr style="border-top:1px solid #f3f4f6;">
              <td style="padding:8px 0;color:#111827;">${pp.name}</td>
              <td style="padding:8px 0;text-align:right;color:#111827;font-family:'DM Mono',monospace;">${pp.hours.toFixed(2)}h</td>
              <td style="padding:8px 0;text-align:right;color:${pp.rate ? '#111827' : '#dc2626'};font-family:'DM Mono',monospace;">${pp.rate ? money(pp.rate) + '/hr' : 'no rate set'}</td>
              <td style="padding:8px 0;text-align:right;color:#111827;font-family:'DM Mono',monospace;font-weight:700;">${money(pp.amount)}</td>
            </tr>
          `).join('')}
          <tr style="border-top:2px solid #d1d5db;">
            <td colspan="3" style="padding:10px 0;text-align:right;color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">Period total</td>
            <td style="padding:10px 0;text-align:right;color:#111827;font-family:'DM Mono',monospace;font-weight:700;font-size:15px;">${money(p.period_total)}</td>
          </tr>
        </tbody>
      </table>
    </td></tr>
  `).join('');

  return `<!DOCTYPE html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f9fafb;padding:24px;color:#111827;">
  <table style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
    <tr><td>
      <div style="font-size:20px;font-weight:700;color:#111827;margin-bottom:4px;">💵 Payroll due</div>
      <div style="font-size:13px;color:#6b7280;margin-bottom:24px;">As of ${fmtDate(s.as_of_date)} · ${s.periods.length} ${s.periods.length === 1 ? 'period' : 'periods'} outstanding</div>
      <table style="width:100%;border-collapse:collapse;">${periodBlocks}</table>
      <div style="margin-top:24px;padding:16px;background:#fef3c7;border-radius:8px;text-align:center;">
        <div style="font-size:11px;color:#92400e;text-transform:uppercase;letter-spacing:0.06em;font-weight:600;margin-bottom:4px;">Grand total</div>
        <div style="font-size:28px;font-weight:700;color:#78350f;font-family:'DM Mono',monospace;">${money(s.grand_total)}</div>
      </div>
      <div style="margin-top:24px;text-align:center;">
        <a href="${APP_URL}" style="display:inline-block;background:#d97706;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:14px;">Open Time tab → Mark Paid</a>
      </div>
      <div style="margin-top:24px;font-size:11px;color:#9ca3af;text-align:center;">
        This reminder fires twice daily (9am + 4pm ET) until every VA is marked paid for the outstanding period(s).<br>
        To silence, click <strong>Mark Paid</strong> on each row in the Time tab.
      </div>
    </td></tr>
  </table>
</body></html>`;
};

const buildSmsBody = (s: Summary) => {
  // Compressed: title + per-person lines + total + link
  const lines: string[] = ['💵 Payroll due'];
  for (const p of s.periods) {
    if (s.periods.length > 1) {
      lines.push(`— ${fmtDate(p.period_start)}–${fmtDate(p.period_end)}:`);
    }
    for (const pp of p.people) {
      const rateLabel = pp.rate ? `$${pp.rate.toFixed(2)}/hr` : 'no rate';
      lines.push(`${pp.name} ${pp.hours.toFixed(2)}h × ${rateLabel} = ${money(pp.amount)}`);
    }
  }
  lines.push(`Total ${money(s.grand_total)}`);
  lines.push(APP_URL);
  return lines.join('\n');
};

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('POST only', { status: 405 });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const db = createClient(supabaseUrl, serviceKey);

  // Auth — verify the incoming secret against the Vault via RPC.
  const candidate = req.headers.get('X-Payroll-Reminder-Secret') ?? '';
  const { data: authOk, error: authErr } = await db.rpc('verify_payroll_reminder_secret', { p_secret: candidate });
  if (authErr) {
    return new Response(JSON.stringify({ error: 'auth check failed', detail: authErr.message }), {
      status: 503, headers: { 'Content-Type': 'application/json' },
    });
  }
  if (authOk !== true) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    });
  }

  // Recompute the summary fresh server-side — never trust a POSTed body.
  const { data: summaryData, error: sumErr } = await db.rpc('payroll_due_summary');
  if (sumErr) {
    return new Response(JSON.stringify({ error: 'summary failed', detail: sumErr.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
  const summary = summaryData as Summary;

  if (!summary?.is_due || !summary.periods?.length) {
    return new Response(JSON.stringify({ skipped: 'not_due' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Numeric coerce — Postgres jsonb numerics arrive as strings sometimes
  summary.grand_total = Number(summary.grand_total);
  summary.periods = summary.periods.map(p => ({
    ...p,
    period_total: Number(p.period_total),
    days_overdue: Number(p.days_overdue),
    people: p.people.map(pp => ({
      ...pp,
      hours:  Number(pp.hours),
      rate:   pp.rate == null ? null : Number(pp.rate),
      amount: Number(pp.amount),
    })),
  }));

  const subject = buildSubject(summary);
  const html    = buildEmailHtml(summary);
  const sms     = buildSmsBody(summary);

  // Fan out: email + SMS in parallel
  const [emailResult, smsResult] = await Promise.allSettled([
    sendEmail(subject, html),
    sendSms(sms),
  ]);

  const emailOk = emailResult.status === 'fulfilled' && emailResult.value.ok;
  const smsOk   = smsResult.status   === 'fulfilled' && smsResult.value.ok;

  return new Response(JSON.stringify({
    sent: true,
    email: { ok: emailOk, detail: emailResult.status === 'fulfilled' ? emailResult.value : String(emailResult.reason) },
    sms:   { ok: smsOk,   detail: smsResult.status   === 'fulfilled' ? smsResult.value   : String(smsResult.reason) },
    summary: {
      periods: summary.periods.length,
      grand_total: summary.grand_total,
    },
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
});

async function sendEmail(subject: string, html: string) {
  const apiKey = Deno.env.get('RESEND_API_KEY');
  if (!apiKey) return { ok: false, error: 'RESEND_API_KEY missing' };
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      from:    FROM_EMAIL,
      to:      [RECIPIENT_EMAIL],
      subject,
      html,
    }),
  });
  const json = await resp.json().catch(() => null);
  return { ok: resp.ok, status: resp.status, json };
}

async function sendSms(body: string) {
  const sid   = Deno.env.get('TWILIO_ACCOUNT_SID');
  const token = Deno.env.get('TWILIO_AUTH_TOKEN');
  const from  = Deno.env.get('TWILIO_FROM_NUMBER') ?? '+15139985440';
  if (!sid || !token) return { ok: false, error: 'Twilio creds missing' };

  const form = new URLSearchParams({
    To:   RECIPIENT_PHONE,
    From: from,
    Body: body,
  });

  const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + btoa(`${sid}:${token}`),
      'Content-Type':  'application/x-www-form-urlencoded',
    },
    body: form,
  });
  const json = await resp.json().catch(() => null);
  return { ok: resp.ok, status: resp.status, sid: json?.sid, json };
}
