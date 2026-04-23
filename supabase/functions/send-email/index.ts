// send-email
//
// Thin Resend wrapper that sends on behalf of Nathan. From shows
// nathan@refundlocators.com (DKIM-verified on Resend). Reply-to +
// bcc point at nathan@fundlocators.com so (a) attorney replies hit
// Nathan's real Gmail inbox, (b) every outbound also copies into
// that same Gmail so he has the record even though refundlocators.com
// has no MX records of its own.
//
// Logs an emails row on success so the Comms thread renders the 📧 bubble.
//
// Request body: { to: string[], cc?: string[], subject, body, deal_id, contact_id? }
// Deploy with verify_jwt=false; we manually decode the Bearer token to
// find sent_by, matching the same pattern Justin uses in send-sms.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const FROM = 'Nathan Johnson <nathan@refundlocators.com>';
const REPLY_TO = 'nathan@fundlocators.com';
const BCC = 'nathan@fundlocators.com';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('POST only', { status: 405, headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return new Response(JSON.stringify({ error: 'Missing authorization' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    const token = authHeader.replace('Bearer ', '');
    let userId: string;
    try {
      const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const payload = JSON.parse(atob(b64));
      userId = payload.sub;
      if (!userId) throw new Error('no sub');
    } catch {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const body = await req.json();
    const { to, cc, subject, body: bodyText, deal_id, contact_id } = body as {
      to: string[] | string; cc?: string[] | string;
      subject: string; body: string;
      deal_id?: string; contact_id?: string;
    };

    const toArr = Array.isArray(to) ? to : (to ? [to] : []);
    const ccArr = Array.isArray(cc) ? cc : (cc ? [cc] : []);

    if (toArr.length === 0 || !subject || !bodyText) {
      return new Response(JSON.stringify({ error: 'to, subject, body required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const db = createClient(supabaseUrl, serviceKey);

    const { data: keyRow } = await db.from('vault.decrypted_secrets').select('decrypted_secret').eq('name', 'resend_api_key').single();
    const resendKey = keyRow?.decrypted_secret;
    if (!resendKey) return new Response(JSON.stringify({ error: 'resend_api_key not in Vault' }), { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const htmlBody = bodyText.split('\n').map(p => `<p style="margin:0 0 12px;">${p.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`).join('');
    const signature = `<p style="margin:18px 0 0;font-size:13px;color:#555;">— Nathan Johnson<br/>RefundLocators<br/>(513) 516-2306 · <a href="https://refundlocators.com">refundlocators.com</a></p>`;
    const fullHtml = htmlBody + signature;

    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM, to: toArr,
        cc: ccArr.length > 0 ? ccArr : undefined,
        bcc: [BCC], reply_to: REPLY_TO,
        subject,
        text: bodyText + '\n\n— Nathan Johnson\nRefundLocators\n(513) 516-2306\nrefundlocators.com',
        html: fullHtml,
      }),
    });

    let respBody: any = null;
    try { respBody = await resp.json(); } catch {}

    if (!resp.ok) {
      await db.from('emails').insert({
        deal_id: deal_id ?? null, contact_id: contact_id ?? null,
        thread_key: deal_id ? (contact_id ? `${deal_id}:contact:${contact_id}` : `${deal_id}:email:${toArr[0]}`) : null,
        direction: 'outbound', from_email: FROM, to_emails: toArr, cc_emails: ccArr, bcc_emails: [BCC], reply_to: REPLY_TO,
        subject, body_text: bodyText, status: 'failed',
        error_message: respBody?.message || respBody?.error || `HTTP ${resp.status}`,
        sent_by: userId,
      });
      return new Response(JSON.stringify({ error: 'Resend error', detail: respBody }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const { data: row } = await db.from('emails').insert({
      deal_id: deal_id ?? null, contact_id: contact_id ?? null,
      thread_key: deal_id ? (contact_id ? `${deal_id}:contact:${contact_id}` : `${deal_id}:email:${toArr[0]}`) : null,
      direction: 'outbound', from_email: FROM, to_emails: toArr, cc_emails: ccArr, bcc_emails: [BCC], reply_to: REPLY_TO,
      subject, body_text: bodyText, body_html: fullHtml,
      resend_id: respBody?.id || null, status: 'sent', sent_by: userId,
    }).select('id').single();

    return new Response(JSON.stringify({ id: row?.id, resend_id: respBody?.id, status: 'sent' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
