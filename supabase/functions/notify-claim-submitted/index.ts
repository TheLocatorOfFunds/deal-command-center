// notify-claim-submitted
//
// Fires when a personalized_links row's claim_submitted_at flips NULL → NOT NULL.
// Sends Nathan an SMS via Twilio + email via Resend with the claim details.
//
// Triggered by Postgres trigger tg_notify_personalized_claim_submitted via
// pg_net.http_post. This closes the parity gap with submit-lead/index.ts —
// both intake paths now alert Nathan within seconds of submission.
//
// Auth: shared secret in X-Notify-Claim-Submitted-Secret header.
//
// Request: POST { token: string }
// Response: { sms_sent: bool, email_sent: bool, deal_id?: string }

import { createClient } from 'jsr:@supabase/supabase-js@2';

const NATHAN_PHONE = '+15135162306';
const NATHAN_EMAIL = 'nathan@fundlocators.com';
const FROM_EMAIL = 'RefundLocators <hello@refundlocators.com>';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const secret = Deno.env.get('NOTIFY_CLAIM_SUBMITTED_SECRET');
  if (!secret) return json({ error: 'NOTIFY_CLAIM_SUBMITTED_SECRET not configured' }, 503);
  if (req.headers.get('X-Notify-Claim-Submitted-Secret') !== secret) return json({ error: 'Unauthorized' }, 401);

  try {
    const { token } = await req.json();
    if (!token) return json({ error: 'token required' }, 400);

    const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // Pull the link + linked deal in one round trip.
    const { data: link, error: linkErr } = await db.from('personalized_links')
      .select('token, first_name, last_name, phone, mailing_address, property_address, county, case_number, deal_id, sale_price, judgment_amount, estimated_surplus_low, estimated_surplus_high, source')
      .eq('token', token)
      .single();
    if (linkErr || !link) return json({ error: 'link not found', details: linkErr?.message }, 404);

    let dealName: string | null = null;
    if (link.deal_id) {
      const { data: deal } = await db.from('deals').select('id, name').eq('id', link.deal_id).single();
      dealName = deal?.name || null;
    }

    const fullName = [link.first_name, link.last_name].filter(Boolean).join(' ') || 'Unknown';
    const surplusMid = link.estimated_surplus_low && link.estimated_surplus_high
      ? Math.round((link.estimated_surplus_low + link.estimated_surplus_high) / 2)
      : null;

    // ── SMS to Nathan (short, scannable) ──
    const smsLines = [
      `🎯 PERSONALIZED CLAIM from ${fullName}`,
      link.phone ? `Phone: ${link.phone}` : null,
      link.property_address ? `Property: ${link.property_address}` : null,
      link.county ? `County: ${link.county}` : null,
      link.case_number ? `Case: ${link.case_number}` : null,
      surplusMid ? `Est. surplus mid: $${surplusMid.toLocaleString()}` : null,
      link.deal_id ? `DCC: ${link.deal_id}` : `Orphan link · src=${link.source}`,
    ].filter(Boolean).join('\n');

    const smsSent = await textNathan(smsLines);

    // ── Email to Nathan (richer detail + CTA link to deal) ──
    const dccUrl = link.deal_id ? `https://app.refundlocators.com/#/deal/${link.deal_id}/overview` : null;
    const emailHtml = `<!DOCTYPE html><html><body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; color:#111827; max-width: 580px; margin: 0 auto; padding: 24px;">
  <div style="background:#0b1f3a; color:#fffcf5; padding: 20px 24px; border-radius: 8px 8px 0 0;">
    <div style="font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; opacity: 0.7;">Personalized claim submitted</div>
    <div style="font-size: 22px; margin-top: 6px; font-weight: 600;">🎯 ${escapeHtml(fullName)}</div>
    <div style="font-size: 13px; margin-top: 4px; opacity: 0.8;">${new Date().toLocaleString('en-US', { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</div>
  </div>
  <div style="background:white; border: 1px solid #e5e7eb; border-top: none; padding: 24px; border-radius: 0 0 8px 8px;">
    <table style="width:100%; font-size: 14px; border-collapse: collapse;">
      ${row('Phone', link.phone)}
      ${row('Property', link.property_address)}
      ${row('Mailing address', link.mailing_address)}
      ${row('County', link.county)}
      ${row('Case #', link.case_number)}
      ${row('Sale price', link.sale_price ? '$' + link.sale_price.toLocaleString() : null)}
      ${row('Judgment', link.judgment_amount ? '$' + link.judgment_amount.toLocaleString() : null)}
      ${row('Est. surplus range', (link.estimated_surplus_low && link.estimated_surplus_high) ? `$${link.estimated_surplus_low.toLocaleString()}–$${link.estimated_surplus_high.toLocaleString()}` : null)}
      ${row('Source', link.source)}
      ${row('Token', link.token)}
      ${row('Deal', dealName ? `${dealName} (${link.deal_id})` : (link.deal_id || 'orphan link — no deal yet'))}
    </table>
    ${dccUrl ? `<p style="margin: 22px 0 0; text-align: center;"><a href="${dccUrl}" style="display: inline-block; padding: 10px 20px; background: #0b1f3a; color: white; text-decoration: none; border-radius: 6px; font-weight: 600;">Open in DCC →</a></p>` : ''}
    <p style="font-size: 11px; color: #9ca3af; margin: 24px 0 0; line-height: 1.5;">From notify-claim-submitted · fired by personalized_links trigger when claim_submitted_at flipped to NOT NULL.</p>
  </div>
</body></html>`;

    const emailSent = await sendEmail(NATHAN_EMAIL, `🎯 Claim from ${fullName} · ${link.county || 'Ohio'}`, emailHtml);

    return json({ sms_sent: smsSent, email_sent: emailSent, deal_id: link.deal_id || null });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});

// ─── helpers ──────────────────────────────────────────────────

async function textNathan(message: string): Promise<boolean> {
  const sid = Deno.env.get('TWILIO_ACCOUNT_SID');
  const token = Deno.env.get('TWILIO_AUTH_TOKEN');
  const from = Deno.env.get('TWILIO_FROM_NUMBER');
  if (!sid || !token || !from) return false;
  try {
    const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${btoa(`${sid}:${token}`)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: NATHAN_PHONE, From: from, Body: message }).toString(),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  const resendKey = Deno.env.get('RESEND_API_KEY');
  if (!resendKey) return false;
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM_EMAIL, to: [to], subject, html }),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

function row(label: string, value: any): string {
  if (value == null || value === '') return '';
  return `<tr><td style="padding: 6px 0; color: #6b7280; width: 36%; vertical-align: top;">${escapeHtml(label)}</td><td style="padding: 6px 0; color: #111827; font-weight: 500;">${escapeHtml(String(value))}</td></tr>`;
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string));
}

function json(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
