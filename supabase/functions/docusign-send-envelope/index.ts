// docusign-send-envelope — sends a DocuSign envelope from a library template.
//
// Called by DocuSignSendModal in DCC when "Send for signature" is clicked.
// Looks up docusign_template_id from library_documents, merges deal fields,
// creates the envelope via DocuSign eSign API (JWT Grant), then fires a
// Twilio SMS with a persistent tap-to-sign link (docusign-sign function).
//
// Required Supabase secrets:
//   DOCUSIGN_INTEGRATION_KEY   — Integration Key UUID from DocuSign Admin
//   DOCUSIGN_USER_ID           — Nathan's DocuSign user ID UUID
//   DOCUSIGN_ACCOUNT_ID        — Account ID (001b848d-cd84-4b78-ada2-cff112350a2c)
//   DOCUSIGN_PRIVATE_KEY       — PKCS#8 RSA key DER body (base64, no headers/newlines).
//                                 Generate: openssl pkcs8 -topk8 -nocrypt -in key.pem | grep -v 'PRIVATE KEY' | tr -d '\n'
//   DOCUSIGN_BASE_URL          — https://na4.docusign.net (default)
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER (optional for SMS)

import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

// authBase: 'https://account-d.docusign.com' for sandbox, 'https://account.docusign.com' for prod.
// Derived from DOCUSIGN_BASE_URL — if it contains 'demo', we're on sandbox.
async function getAccessToken(
  integrationKey: string, userId: string, privateKeyPem: string, authBase: string
): Promise<string> {
  // DOCUSIGN_PRIVATE_KEY is stored as base64(PEM) to avoid newline encoding issues.
  // Decode it to get the actual PEM text, then strip headers and whitespace to get the DER body.
  // DOCUSIGN_PRIVATE_KEY is stored as the raw base64 DER body of the PKCS#8 key
  // (no PEM headers, no newlines — just the base64 content between BEGIN/END PRIVATE KEY lines).
  // This format works reliably with Deno's atob() without any newline/encoding issues.
  const der = Uint8Array.from(atob(privateKeyPem.trim()), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    'pkcs8', der.buffer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
  );
  const b64u = (s: string | Uint8Array) => {
    const str = typeof s === 'string' ? s : String.fromCharCode(...(s as Uint8Array));
    return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  };
  const aud = authBase.replace('https://', '');  // e.g. 'account-d.docusign.com'
  const now = Math.floor(Date.now() / 1000);
  const header  = { alg: 'RS256', typ: 'JWT' };
  const payload = { iss: integrationKey, sub: userId, aud,
                    iat: now, exp: now + 3600, scope: 'signature impersonation' };
  const sigInput = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(sigInput)));
  const jwt = `${sigInput}.${b64u(sig)}`;
  const resp = await fetch(`${authBase}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  if (!resp.ok) throw new Error(`JWT Grant failed: ${resp.status} ${await resp.text()}`);
  const { access_token } = await resp.json();
  return access_token;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });

  const INTEGRATION_KEY = Deno.env.get('DOCUSIGN_INTEGRATION_KEY');
  const USER_ID         = Deno.env.get('DOCUSIGN_USER_ID');
  const ACCOUNT_ID      = Deno.env.get('DOCUSIGN_ACCOUNT_ID');
  const PRIVATE_KEY     = Deno.env.get('DOCUSIGN_PRIVATE_KEY');
  const BASE_URL        = Deno.env.get('DOCUSIGN_BASE_URL') || 'https://na4.docusign.net';
  // Derive auth base from eSign base URL: demo → sandbox OAuth, anything else → production OAuth
  const AUTH_BASE       = BASE_URL.includes('demo') ? 'https://account-d.docusign.com' : 'https://account.docusign.com';

  if (!INTEGRATION_KEY || !USER_ID || !ACCOUNT_ID || !PRIVATE_KEY) {
    return json({ error: 'docusign_not_configured',
      message: 'Add DOCUSIGN_INTEGRATION_KEY, DOCUSIGN_USER_ID, DOCUSIGN_ACCOUNT_ID, DOCUSIGN_PRIVATE_KEY secrets.' });
  }

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'invalid_json' }, 400); }

  const { deal_id, library_document_id, recipient_email, recipient_name,
          recipient_phone, email_subject_override, merge_overrides = {} } = body;

  if (!deal_id || !library_document_id || !recipient_email || !recipient_name) {
    return json({ error: 'missing_fields',
      message: 'deal_id, library_document_id, recipient_email, recipient_name required' }, 400);
  }

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  const { data: libDoc } = await db.from('library_documents')
    .select('title, docusign_template_id, template_fields')
    .eq('id', library_document_id).single();

  if (!libDoc?.docusign_template_id) {
    return json({ error: 'not_a_docusign_template',
      message: 'This library document has no docusign_template_id set.' });
  }

  let accessToken: string;
  try {
    accessToken = await getAccessToken(INTEGRATION_KEY, USER_ID, PRIVATE_KEY, AUTH_BASE);
  } catch (e: any) {
    console.error('[docusign-send-envelope] JWT Grant error:', e.message);
    return json({ error: 'auth_failed', message: e.message }, 500);
  }

  const textTabs = Object.entries(merge_overrides as Record<string, string>)
    .filter(([, v]) => v != null && v !== '')
    .map(([tabLabel, value]) => ({ tabLabel, value: String(value) }));

  const emailSubject = email_subject_override || `Please sign: ${libDoc.title}`;

  // clientUserId marks envelope as embedded so we can generate recipient view URLs
  const clientUserId = crypto.randomUUID();

  const envelopeBody: any = {
    templateId: libDoc.docusign_template_id,
    emailSubject,
    status: 'sent',
    templateRoles: [{
      email:        recipient_email,
      name:         recipient_name,
      roleName:     'Claimant',
      clientUserId,
      ...(textTabs.length > 0 ? { tabs: { textTabs } } : {}),
    }],
  };

  const dsResp = await fetch(`${BASE_URL}/restapi/v2.1/accounts/${ACCOUNT_ID}/envelopes`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(envelopeBody),
  });

  if (!dsResp.ok) {
    const errText = await dsResp.text();
    console.error('[docusign-send-envelope] DocuSign API error:', dsResp.status, errText);
    let detail = errText;
    try { const e = JSON.parse(errText); detail = e.message || e.errorCode || errText; } catch { /* noop */ }
    return json({ error: 'docusign_api_error', message: detail }, 502);
  }

  const { envelopeId, status } = await dsResp.json();
  const now = new Date().toISOString();

  // Persist envelope
  await db.from('docusign_envelopes').upsert({
    deal_id, envelope_id: envelopeId,
    library_document_id,
    recipient_name, recipient_email,
    status, sent_at: now, updated_at: now,
  }, { onConflict: 'envelope_id' });

  // Create persistent signing token for SMS link
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const projectRef  = supabaseUrl.match(/https:\/\/([^.]+)/)?.[1] || '';
  const signingBase = `https://${projectRef}.supabase.co/functions/v1/docusign-sign`;

  const { data: tokenRow } = await db.from('signing_tokens').insert({
    deal_id,
    envelope_id:    envelopeId,
    signer_name:    recipient_name,
    signer_email:   recipient_email,
    signer_phone:   recipient_phone || null,
    client_user_id: clientUserId,
    return_url:     'https://thelocatoroffunds.github.io/deal-command-center/signed.html',
  }).select('token').single();

  const signingLink = tokenRow?.token ? `${signingBase}?t=${tokenRow.token}` : null;

  // Fire Twilio SMS if phone provided
  let smsSent = false;
  if (recipient_phone && signingLink) {
    const twilioSid   = Deno.env.get('TWILIO_ACCOUNT_SID');
    const twilioToken = Deno.env.get('TWILIO_AUTH_TOKEN');
    const fromNumber  = Deno.env.get('TWILIO_FROM_NUMBER') || '+15139985440';

    if (twilioSid && twilioToken) {
      const firstName = recipient_name.split(' ')[0];
      const smsBody   = `Hi ${firstName}, this is Nathan with RefundLocators. Your authorization letter is ready to sign — tap the link and sign right from your phone (takes 60 seconds):\n\n${signingLink}\n\nQuestions? Call/text (513) 998-5440.`;
      // Normalize to E.164 — strip non-digits, prepend +1 if no country code
      const digitsOnly = recipient_phone.replace(/\D/g, '');
      const toPhone = recipient_phone.startsWith('+') ? recipient_phone
                    : digitsOnly.length === 11 ? `+${digitsOnly}`
                    : `+1${digitsOnly}`;
      try {
        const smsResp = await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`,
          {
            method: 'POST',
            headers: {
              'Authorization': 'Basic ' + btoa(`${twilioSid}:${twilioToken}`),
              'Content-Type':  'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({ To: toPhone, From: fromNumber, Body: smsBody }).toString(),
          }
        );
        smsSent = smsResp.ok;
        if (!smsResp.ok) console.error('[docusign-send-envelope] Twilio error:', await smsResp.text());
      } catch (e: any) {
        console.error('[docusign-send-envelope] Twilio exception:', e.message);
      }
    }
  }

  // Activity log
  const parts = [`📝 DocuSign sent to ${recipient_name} (${recipient_email}) — ${libDoc.title}`];
  if (smsSent)          parts.push(`📱 Signing link texted to ${recipient_phone}`);
  else if (signingLink) parts.push(`🔗 Signing link ready (no phone provided)`);
  await db.from('activity').insert({ deal_id, action: parts.join(' · ') });

  return json({ envelope_id: envelopeId, status, sent_at: now, signing_link: signingLink, sms_sent: smsSent });
});
