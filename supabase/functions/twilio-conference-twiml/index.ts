// twilio-conference-twiml — Public TwiML endpoint called by Twilio (no auth).
//
// Usage modes:
//
//   Conference (default):
//     GET/POST ?conf=dcc-<callSid>
//     Returns TwiML that places the caller into the named conference room.
//
//   Transfer (blind):
//     GET/POST ?action=transfer&to=+15135551234&from=+15139985440
//     Returns TwiML that dials the destination number and hangs up the caller
//     once the transfer leg connects.
//
// Deploy with verify_jwt=false — Twilio does not send Supabase JWTs.

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // Support both GET query params and POST form body
  let params: URLSearchParams;
  if (req.method === 'POST') {
    try {
      const text = await req.text();
      params = new URLSearchParams(text);
      // Merge any query params too
      url.searchParams.forEach((v, k) => { if (!params.has(k)) params.set(k, v); });
    } catch {
      params = url.searchParams;
    }
  } else {
    params = url.searchParams;
  }

  const action = params.get('action') ?? 'conference';

  let twiml: string;

  if (action === 'transfer') {
    const to   = params.get('to')   ?? '';
    const from = params.get('from') ?? '';
    if (!to) {
      return new Response('<Response><Hangup/></Response>', {
        headers: { 'Content-Type': 'application/xml' },
      });
    }
    twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial callerId="${from || ''}" timeout="30">
    <Number>${to}</Number>
  </Dial>
</Response>`;
  } else {
    // Conference mode
    const conf = params.get('conf') ?? '';
    if (!conf) {
      return new Response('<Response><Hangup/></Response>', {
        headers: { 'Content-Type': 'application/xml' },
      });
    }
    twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial>
    <Conference
      beep="false"
      startConferenceOnEnter="true"
      endConferenceOnExit="false"
      waitUrl=""
    >${conf}</Conference>
  </Dial>
</Response>`;
  }

  return new Response(twiml, {
    headers: {
      'Content-Type': 'application/xml',
      'Cache-Control': 'no-store',
    },
  });
});
