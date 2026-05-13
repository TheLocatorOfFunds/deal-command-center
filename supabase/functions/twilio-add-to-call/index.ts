// twilio-add-to-call — Add a participant to an active call or transfer it.
//
// POST body (JSON):
//   call_sid   string  — The active Twilio call SID to bridge into a conference
//   to_number  string  — E.164 number to add (e.g. "+15135551234")
//   action?    string  — 'conference' (default) | 'transfer'
//
// Conference flow:
//   1. Redirect the active call to a TwiML conference room
//   2. Dial the new number into the same conference room
//   Both parties end up in the named conference.
//
// Transfer flow:
//   Redirect the active call to TwiML that dials the new number directly.
//   The browser client disconnects once the transfer leg connects.
//
// Auth: Bearer JWT (Supabase anon/service key) or RELAY_SECRET header.
//
// Env vars required:
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER,
//   SUPABASE_URL (auto-injected by Supabase Edge Runtime)

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-relay-secret',
};

const normalizePhone = (p: string): string => {
  const digits = (p || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return p.startsWith('+') ? p : '+' + digits;
};

const twilioFetch = async (
  url: string,
  method: 'POST' | 'GET',
  body: Record<string, string>,
  acctSid: string,
  authToken: string,
): Promise<Response> => {
  const encoded = new URLSearchParams(body).toString();
  return fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + btoa(`${acctSid}:${authToken}`),
    },
    body: encoded,
  });
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST only' }), { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const acctSid   = Deno.env.get('TWILIO_ACCOUNT_SID') ?? '';
  const authToken = Deno.env.get('TWILIO_AUTH_TOKEN') ?? '';
  const fromNum   = Deno.env.get('TWILIO_FROM_NUMBER') ?? '+15139985440';
  const supaUrl   = Deno.env.get('SUPABASE_URL') ?? '';

  if (!acctSid || !authToken) {
    return new Response(JSON.stringify({ error: 'Missing Twilio credentials in env' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  let body: { call_sid?: string; to_number?: string; action?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const { call_sid, to_number, action = 'conference' } = body;

  if (!call_sid || typeof call_sid !== 'string') {
    return new Response(JSON.stringify({ error: 'call_sid is required' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  if (!to_number || typeof to_number !== 'string') {
    return new Response(JSON.stringify({ error: 'to_number is required' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const toNormalized = normalizePhone(to_number);
  if (!toNormalized) {
    return new Response(JSON.stringify({ error: 'Invalid to_number' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const callApiBase = `https://api.twilio.com/2010-04-01/Accounts/${acctSid}/Calls`;

  if (action === 'transfer') {
    // Blind transfer: redirect the active call to TwiML that dials the new number
    const twimlUrl = `${supaUrl}/functions/v1/twilio-conference-twiml?action=transfer&to=${encodeURIComponent(toNormalized)}&from=${encodeURIComponent(fromNum)}`;

    const redirectRes = await twilioFetch(
      `${callApiBase}/${call_sid}.json`,
      'POST',
      { Url: twimlUrl, Method: 'POST' },
      acctSid,
      authToken,
    );

    const redirectData = await redirectRes.json();
    if (!redirectRes.ok) {
      return new Response(JSON.stringify({ error: redirectData.message || 'Twilio redirect failed' }), {
        status: redirectRes.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ ok: true, action: 'transfer', to: toNormalized }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Default: conference
  const conferenceName = `dcc-${call_sid}`;
  const twimlUrl = `${supaUrl}/functions/v1/twilio-conference-twiml?conf=${encodeURIComponent(conferenceName)}`;

  // Step 1: Redirect the active browser call into the conference room
  const redirectRes = await twilioFetch(
    `${callApiBase}/${call_sid}.json`,
    'POST',
    { Url: twimlUrl, Method: 'POST' },
    acctSid,
    authToken,
  );

  const redirectData = await redirectRes.json();
  if (!redirectRes.ok) {
    return new Response(JSON.stringify({ error: redirectData.message || 'Failed to redirect call to conference' }), {
      status: redirectRes.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Step 2: Dial the new number into the same conference room
  const dialRes = await twilioFetch(
    `${callApiBase}.json`,
    'POST',
    {
      To:     toNormalized,
      From:   fromNum,
      Url:    twimlUrl,
      Method: 'POST',
    },
    acctSid,
    authToken,
  );

  const dialData = await dialRes.json();
  if (!dialRes.ok) {
    return new Response(JSON.stringify({ error: dialData.message || 'Failed to dial new participant' }), {
      status: dialRes.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  return new Response(
    JSON.stringify({
      ok: true,
      action: 'conference',
      conference_name: conferenceName,
      new_call_sid: dialData.sid,
    }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );
});
