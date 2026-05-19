// twilio-recording — proxies Twilio call recording audio to the browser.
//
// Twilio recording URLs require HTTP Basic Auth (Account SID + Auth Token).
// The browser can't add those headers when loading <audio src="...">, so it
// shows a Basic Auth popup instead. This edge function sits in between:
//   browser <audio src="/functions/v1/twilio-recording?sid=RE...">
//     → this function fetches from Twilio with auth
//     → streams the MP3 back to the browser (no auth dialog)
//
// Required env vars:
//   TWILIO_ACCOUNT_SID
//   TWILIO_AUTH_TOKEN
//
// Deploy with verify_jwt=true (only authenticated DCC users play recordings).

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, range',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Expose-Headers': 'content-length, content-range, accept-ranges',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const sid = url.searchParams.get('sid');

  if (!sid || !sid.startsWith('RE')) {
    return new Response(JSON.stringify({ error: 'Missing or invalid recording SID' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const accountSid = Deno.env.get('TWILIO_ACCOUNT_SID');
  const authToken  = Deno.env.get('TWILIO_AUTH_TOKEN');

  if (!accountSid || !authToken) {
    return new Response(JSON.stringify({ error: 'Missing Twilio credentials' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings/${sid}.mp3`;

  // Forward any Range header so the browser's audio player can seek
  const rangeHeader = req.headers.get('range');
  const fetchHeaders: Record<string, string> = {
    'Authorization': 'Basic ' + btoa(`${accountSid}:${authToken}`),
  };
  if (rangeHeader) fetchHeaders['Range'] = rangeHeader;

  const twilioResp = await fetch(twilioUrl, { headers: fetchHeaders });

  if (!twilioResp.ok && twilioResp.status !== 206) {
    return new Response(JSON.stringify({ error: `Twilio returned ${twilioResp.status}` }), {
      status: twilioResp.status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Stream the audio back, preserving content headers for the audio player
  const responseHeaders: Record<string, string> = {
    ...corsHeaders,
    'Content-Type': twilioResp.headers.get('content-type') || 'audio/mpeg',
    'Cache-Control': 'private, max-age=3600',
  };
  if (twilioResp.headers.get('content-length')) {
    responseHeaders['Content-Length'] = twilioResp.headers.get('content-length')!;
  }
  if (twilioResp.headers.get('content-range')) {
    responseHeaders['Content-Range'] = twilioResp.headers.get('content-range')!;
    responseHeaders['Accept-Ranges'] = 'bytes';
  }

  return new Response(twilioResp.body, {
    status: twilioResp.status,
    headers: responseHeaders,
  });
});
