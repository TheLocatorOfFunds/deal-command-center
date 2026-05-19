// docusign-sign — persistent signing link handler for SMS-delivered envelopes.
//
// Homeowner receives a Twilio SMS:
//   "Tap to sign: https://<project>.supabase.co/functions/v1/docusign-sign?t=<token>"
//
// Flow:
//   1. Look up signing_token row by UUID
//   2. Call DocuSign createRecipientView → fresh 5-min signing URL
//   3. Redirect homeowner's browser to that URL
//   4. After signing, DocuSign redirects to signed.html
//
// Token is valid as long as the DocuSign envelope is open. Multiple taps fine.
// Deploy with verify_jwt=false — homeowners have no Supabase auth.
//
// Required Supabase secrets (same as docusign-send-envelope):
//   DOCUSIGN_INTEGRATION_KEY, DOCUSIGN_USER_ID, DOCUSIGN_ACCOUNT_ID,
//   DOCUSIGN_PRIVATE_KEY (PKCS#8 DER base64, no headers/newlines),
//   DOCUSIGN_BASE_URL

import { createClient } from 'jsr:@supabase/supabase-js@2';

// authBase: 'https://account-d.docusign.com' for sandbox, 'https://account.docusign.com' for prod.
// Derived from DOCUSIGN_BASE_URL — if it contains 'demo', we're on sandbox.
async function getAccessToken(
  integrationKey: string, userId: string, privateKeyPem: string, authBase: string
): Promise<string> {
  // DOCUSIGN_PRIVATE_KEY is stored as the raw base64 DER body of the PKCS#8 key
  // (no PEM headers, no newlines — just the base64 content between BEGIN/END PRIVATE KEY lines).
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
  const input   = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
  const sig     = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(input)));
  const jwt     = `${input}.${b64u(sig)}`;
  const resp    = await fetch(`${authBase}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  if (!resp.ok) throw new Error(`JWT Grant failed: ${resp.status} ${await resp.text()}`);
  const { access_token } = await resp.json();
  return access_token;
}

const errorPage = (msg: string) => `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Signing Link — RefundLocators</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,sans-serif;background:#0c0a09;color:#fafaf9;
  display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
.card{background:#1c1917;border:1px solid #292524;border-radius:12px;
  padding:32px;max-width:420px;width:100%;text-align:center}
h2{color:#ef4444;margin:0 0 12px;font-size:20px}
p{color:#a8a29e;line-height:1.6;margin:0}
a{color:#d97706;text-decoration:none}
</style></head>
<body><div class="card">
<h2>⚠️ Link Unavailable</h2>
<p>${msg}</p><br>
<p>Call us at <a href="tel:+15139985440">(513) 998-5440</a></p>
</div></body></html>`;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*' } });

  const url   = new URL(req.url);
  const token = url.searchParams.get('t');

  if (!token) {
    return new Response(errorPage('No signing token found. Please use the link from your text message.'),
      { status: 400, headers: { 'Content-Type': 'text/html' } });
  }

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  const { data: row, error } = await db
    .from('signing_tokens').select('*').eq('token', token).single();

  if (error || !row) {
    return new Response(errorPage('This signing link is invalid or expired. Please contact us for a new one.'),
      { status: 404, headers: { 'Content-Type': 'text/html' } });
  }

  const INTEGRATION_KEY = Deno.env.get('DOCUSIGN_INTEGRATION_KEY');
  const USER_ID         = Deno.env.get('DOCUSIGN_USER_ID');
  const PRIVATE_KEY     = Deno.env.get('DOCUSIGN_PRIVATE_KEY');
  const ACCOUNT_ID      = Deno.env.get('DOCUSIGN_ACCOUNT_ID');
  const BASE_URL        = Deno.env.get('DOCUSIGN_BASE_URL') || 'https://na4.docusign.net';
  const AUTH_BASE       = BASE_URL.includes('demo') ? 'https://account-d.docusign.com' : 'https://account.docusign.com';

  if (!INTEGRATION_KEY || !USER_ID || !PRIVATE_KEY || !ACCOUNT_ID) {
    return new Response(errorPage('Signing service temporarily unavailable. Please call (513) 998-5440.'),
      { status: 503, headers: { 'Content-Type': 'text/html' } });
  }

  let accessToken: string;
  try {
    accessToken = await getAccessToken(INTEGRATION_KEY, USER_ID, PRIVATE_KEY, AUTH_BASE);
  } catch (e: any) {
    console.error('[docusign-sign] JWT error:', e.message);
    return new Response(errorPage('Authentication error. Please call (513) 998-5440.'),
      { status: 503, headers: { 'Content-Type': 'text/html' } });
  }

  const returnUrl = row.return_url || 'https://thelocatoroffunds.github.io/deal-command-center/signed.html';

  const viewResp = await fetch(
    `${BASE_URL}/restapi/v2.1/accounts/${ACCOUNT_ID}/envelopes/${row.envelope_id}/views/recipient`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        returnUrl,
        authenticationMethod: 'none',
        email:        row.signer_email,
        userName:     row.signer_name,
        clientUserId: row.client_user_id,
      }),
    }
  );

  if (!viewResp.ok) {
    const errBody = await viewResp.text();
    console.error('[docusign-sign] createRecipientView error:', viewResp.status, errBody);
    let msg = 'This document is no longer available for signing.';
    try {
      const p = JSON.parse(errBody);
      if (p.errorCode === 'ENVELOPE_IS_COMPLETE') msg = '✅ This document has already been signed. Thank you!';
    } catch { /* noop */ }
    return new Response(errorPage(msg), { status: 410, headers: { 'Content-Type': 'text/html' } });
  }

  const { url: signingUrl } = await viewResp.json();

  // Track usage
  await db.from('signing_tokens').update({
    used_count:   (row.used_count || 0) + 1,
    last_used_at: new Date().toISOString(),
  }).eq('id', row.id);

  if ((row.used_count || 0) === 0) {
    await db.from('activity').insert({
      deal_id: row.deal_id,
      action:  `📱 ${row.signer_name} opened signing link from SMS`,
    });
  }

  return new Response(null, { status: 302, headers: { Location: signingUrl } });
});
