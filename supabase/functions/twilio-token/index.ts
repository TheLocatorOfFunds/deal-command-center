// twilio-token — generates a Twilio Voice Access Token for the browser SDK.
//
// The DCC browser calls this to get a short-lived JWT, then hands it to
// Twilio.Device so the browser can make and receive calls directly.
//
// ALL DCC browsers register under the SAME identity ('dcc-fundlocators').
// Twilio delivers inbound calls to every registered Device with that identity
// simultaneously — so Justin, Nathan, and any future team member all ring
// without any per-user wiring. This is documented Twilio behavior:
//   "If multiple Twilio.Device instances register under the same identity,
//    Twilio sends the incoming call to all registered devices simultaneously."
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

// Single shared identity for all DCC browsers.
// Twilio rings ALL registered devices with this identity on inbound calls.
const DCC_IDENTITY = 'dcc-fundlocators';

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

  console.log('[twilio-token] issuing identity:', DCC_IDENTITY);

  const now = Math.floor(Date.now() / 1000);

  const header = { alg: 'HS256', typ: 'JWT', cty: 'twilio-fpa;v=1' };
  const payload = {
    jti:    `${API_KEY}-${now}`,
    iss:    API_KEY,
    sub:    ACCOUNT_SID,
    nbf:    now,
    exp:    now + 3600, // 1-hour token
    grants: {
      identity: DCC_IDENTITY,
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
    JSON.stringify({ token, identity: DCC_IDENTITY }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
});
