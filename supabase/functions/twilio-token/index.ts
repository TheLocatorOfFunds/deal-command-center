// twilio-token — generates a Twilio Voice Access Token for the browser SDK.
//
// The DCC browser calls this to get a short-lived JWT, then hands it to
// Twilio.Device so the browser can make and receive calls directly.
//
// Each user gets a UNIQUE Twilio client identity derived from their email
// prefix (e.g. justin@fundlocators.com → "dcc-justin"). This ensures every
// team member's browser registers under its own identity, so the TwiML can
// dial all identities simultaneously and every browser rings on inbound calls.
//
// Required env vars (set in Supabase project secrets):
//   TWILIO_ACCOUNT_SID   — AC...
//   TWILIO_API_KEY       — SK... (API Key SID, NOT the account SID)
//   TWILIO_API_SECRET    — the corresponding secret
//   TWILIO_TWIML_APP_SID — AP... (the TwiML App whose Voice URL handles outbound)
//
// Deploy with default verify_jwt=true (only authenticated DCC users call this).

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const ACCOUNT_SID    = Deno.env.get('TWILIO_ACCOUNT_SID')!;
  const API_KEY        = Deno.env.get('TWILIO_API_KEY')!;
  const API_SECRET     = Deno.env.get('TWILIO_API_SECRET')!;
  const TWIML_APP_SID  = Deno.env.get('TWILIO_TWIML_APP_SID')!;

  if (!ACCOUNT_SID || !API_KEY || !API_SECRET || !TWIML_APP_SID) {
    return new Response(
      JSON.stringify({ error: 'Missing Twilio env vars' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // Derive a per-user Twilio client identity from the logged-in user's email.
  // e.g. justin@fundlocators.com → "dcc-justin"
  // This must match the identities listed in DCC_CLIENT_IDENTITIES in twilio-voice.
  //
  // We decode the email directly from the Supabase JWT payload (base64url JSON).
  // Supabase's gateway already verified the JWT signature before invoking this
  // function (verify_jwt=true), so we can trust the payload without re-verifying.
  // This avoids an extra auth.getUser() round-trip and any SUPABASE_ANON_KEY
  // dependency that could silently fail and fall back to 'dcc-browser'.
  let identity = 'dcc-browser'; // fallback
  try {
    const authHeader = req.headers.get('Authorization') || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (token) {
      const parts = token.split('.');
      if (parts.length === 3) {
        // base64url → base64: swap chars, then re-add stripped '=' padding
        const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
        const payload = JSON.parse(atob(padded));
        const email: string | undefined = payload.email ?? payload.user_metadata?.email;
        if (email) {
          const prefix = email.split('@')[0].toLowerCase().replace(/[^a-z0-9-]/g, '-');
          identity = `dcc-${prefix}`;
        }
      }
    }
  } catch (_) { /* fall back to dcc-browser */ }

  console.log('[twilio-token] issuing identity:', identity);

  const now = Math.floor(Date.now() / 1000);

  const header = { alg: 'HS256', typ: 'JWT', cty: 'twilio-fpa;v=1' };
  const payload = {
    jti:    `${API_KEY}-${now}`,
    iss:    API_KEY,
    sub:    ACCOUNT_SID,
    nbf:    now,
    exp:    now + 3600, // 1-hour token
    grants: {
      identity,
      voice: {
        incoming: { allow: true },
        outgoing: { application_sid: TWIML_APP_SID },
      },
    },
  };

  // Build JWT manually using Web Crypto (no npm dependency needed)
  const b64url = (obj: unknown) =>
    btoa(JSON.stringify(obj))
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');

  const signingInput = `${b64url(header)}.${b64url(payload)}`;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(API_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));
  const sig = btoa(String.fromCharCode(...new Uint8Array(sigBytes)))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  const token = `${signingInput}.${sig}`;

  return new Response(
    JSON.stringify({ token, identity }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
});
