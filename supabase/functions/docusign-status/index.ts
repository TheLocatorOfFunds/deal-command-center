// docusign-status — syncs DocuSign envelope status back into DCC.
//
// Two modes:
//   POST — DocuSign Connect webhook (real-time events from DocuSign)
//   GET  — on-demand poll (?deal_id=xxx or ?envelope_id=xxx) from DCC UI
//
// DocuSign Connect setup (do once in DocuSign Admin → Connect):
//   URL: https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/docusign-status
//   Events: Envelope Sent, Delivered, Completed, Declined, Voided
//
// Deploy with verify_jwt=false — DocuSign webhooks carry no Supabase JWT.
//
// Required Supabase secrets (same as docusign-send-envelope):
//   DOCUSIGN_INTEGRATION_KEY, DOCUSIGN_USER_ID, DOCUSIGN_ACCOUNT_ID,
//   DOCUSIGN_PRIVATE_KEY (PKCS#8 DER base64, no headers/newlines),
//   DOCUSIGN_BASE_URL

import { createClient } from 'jsr:@supabase/supabase-js@2';

const STATUS_MAP: Record<string, string> = {
  sent: 'sent', delivered: 'delivered', completed: 'completed',
  declined: 'declined', voided: 'voided', created: 'created',
};

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

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  // ── DocuSign Connect webhook ───────────────────────────────────────────────
  if (req.method === 'POST') {
    const xml = await req.text().catch(() => '');
    const envelopeId = xml.match(/<EnvelopeID>([^<]+)<\/EnvelopeID>/)?.[1];
    const dsStatus   = xml.match(/<Status>([^<]+)<\/Status>/)?.[1]?.toLowerCase();
    if (!envelopeId || !dsStatus) return new Response('ok', { status: 200 });

    const status = STATUS_MAP[dsStatus] || dsStatus;
    const now    = new Date().toISOString();

    const { data: row } = await db.from('docusign_envelopes')
      .update({ status, updated_at: now, ...(status === 'completed' ? { completed_at: now } : {}) })
      .eq('envelope_id', envelopeId)
      .select('deal_id, signer_name').single();

    if (row?.deal_id) {
      const verb = status === 'completed' ? 'signed & completed' : status === 'delivered' ? 'viewed'
                 : status === 'declined' ? 'declined' : status;
      await db.from('activity').insert({
        deal_id: row.deal_id,
        action:  `📝 DocuSign: ${row.signer_name} ${verb} the authorization letter`,
      });
    }
    return new Response('ok', { status: 200 });
  }

  // ── On-demand poll ─────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const url    = new URL(req.url);
    const dealId = url.searchParams.get('deal_id');
    const envId  = url.searchParams.get('envelope_id');

    if (!dealId && !envId) {
      return new Response(JSON.stringify({ error: 'Pass deal_id or envelope_id' }),
        { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    let q = db.from('docusign_envelopes').select('*').order('sent_at', { ascending: false });
    if (dealId) q = q.eq('deal_id', dealId);
    if (envId)  q = q.eq('envelope_id', envId);
    const { data: rows } = await q;

    // Refresh non-terminal envelopes from DocuSign live
    const INTEGRATION_KEY = Deno.env.get('DOCUSIGN_INTEGRATION_KEY');
    const USER_ID         = Deno.env.get('DOCUSIGN_USER_ID');
    const PRIVATE_KEY     = Deno.env.get('DOCUSIGN_PRIVATE_KEY');
    const ACCOUNT_ID      = Deno.env.get('DOCUSIGN_ACCOUNT_ID');
    const BASE_URL        = Deno.env.get('DOCUSIGN_BASE_URL') || 'https://na4.docusign.net';
    const AUTH_BASE       = BASE_URL.includes('demo') ? 'https://account-d.docusign.com' : 'https://account.docusign.com';

    const terminal = new Set(['completed', 'declined', 'voided']);
    const toRefresh = (rows || []).filter(r => !terminal.has(r.status));

    if (toRefresh.length > 0 && INTEGRATION_KEY && USER_ID && PRIVATE_KEY) {
      const token = await getAccessToken(INTEGRATION_KEY, USER_ID, PRIVATE_KEY, AUTH_BASE);
      for (const row of toRefresh) {
        const r = await fetch(
          `${BASE_URL}/restapi/v2.1/accounts/${ACCOUNT_ID}/envelopes/${row.envelope_id}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!r.ok) continue;
        const { status: ds } = await r.json();
        const status = STATUS_MAP[ds?.toLowerCase()] || ds?.toLowerCase();
        if (status && status !== row.status) {
          const now = new Date().toISOString();
          await db.from('docusign_envelopes')
            .update({ status, updated_at: now, ...(status === 'completed' ? { completed_at: now } : {}) })
            .eq('envelope_id', row.envelope_id);
          row.status = status;
        }
      }
    }

    return new Response(JSON.stringify(rows || []),
      { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } });
  }

  return new Response('Method not allowed', { status: 405 });
});
