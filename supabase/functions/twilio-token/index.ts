// twilio-token — generates a Twilio Voice Access Token for browser + mobile SDKs.
//
// The DCC web app and DCC mobile app call this to get a short-lived JWT, then
// hand it to Voice.Device (web) / Voice.register (mobile) so the client can
// make and receive Twilio Voice calls directly.
//
// ALL DCC clients (web + mobile) register under the SAME identity
// ('dcc-fundlocators'). Twilio delivers inbound calls to every registered
// Device with that identity simultaneously — so Justin, Nathan, and any
// future team member all ring on every signed-in surface, without any
// per-user wiring.
//
// The grants.voice.push_credential_sid below routes inbound VoIP push
// notifications to iOS via PushKit using the APNs cert uploaded to Twilio.
// Without it, mobile inbound ringing doesn't work.
//
// Required env vars (set in Supabase project secrets):
//   TWILIO_ACCOUNT_SID                — AC...
//   TWILIO_API_KEY                    — SK... (API Key SID, NOT the account SID)
//   TWILIO_API_SECRET                 — the corresponding secret
//   TWILIO_TWIML_APP_SID              — AP... (the TwiML App whose Voice URL handles outbound)
//   TWILIO_VOICE_PUSH_CREDENTIAL_SID  — CR... (optional — enables iOS VoIP push)
//
// Deploy with default verify_jwt=true (only authenticated DCC users call this).

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const DCC_IDENTITY = 'dcc-fundlocators';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const ACCOUNT_SID         = Deno.env.get('TWILIO_ACCOUNT_SID')!;
  const API_KEY             = Deno.env.get('TWILIO_API_KEY')!;
  const API_SECRET          = Deno.env.get('TWILIO_API_SECRET')!;
  const TWIML_APP_SID       = Deno.env.get('TWILIO_TWIML_APP_SID')!;
  const PUSH_CREDENTIAL_SID = Deno.env.get('TWILIO_VOICE_PUSH_CREDENTIAL_SID') || '';

  if (!ACCOUNT_SID || !API_KEY || !API_SECRET || !TWIML_APP_SID) {
    return new Response(
      JSON.stringify({ error: 'Missing Twilio env vars' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  console.log('[twilio-token] issuing identity:', DCC_IDENTITY, 'push:', PUSH_CREDENTIAL_SID ? 'on' : 'off');

  const now = Math.floor(Date.now() / 1000);

  const voiceGrant: Record<string, unknown> = {
    incoming: { allow: true },
    outgoing: { application_sid: TWIML_APP_SID },
  };
  // Enables iOS VoIP push delivery via PushKit using the Push Credential.
  // No-op if not set — web clients don't need this.
  if (PUSH_CREDENTIAL_SID) {
    voiceGrant.push_credential_sid = PUSH_CREDENTIAL_SID;
  }

  const header = { alg: 'HS256', typ: 'JWT', cty: 'twilio-fpa;v=1' };
  const payload = {
    jti:    `${API_KEY}-${now}`,
    iss:    API_KEY,
    sub:    ACCOUNT_SID,
    nbf:    now,
    exp:    now + 43200, // 12-hour token (tokenWillExpire auto-refreshes at T-3min)
    grants: {
      identity: DCC_IDENTITY,
      voice: voiceGrant,
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
