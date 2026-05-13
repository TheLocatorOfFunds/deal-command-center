// twilio-voice-screen — call-screening prompt for the 2306 parallel leg.
//
// Pattern: when a call hits +1 513 998 5440, twilio-voice TwiML dials
// every DCC client (web + mobile) AND in parallel dials Nathan's
// Spectrum iPhone at +1 513 998 2306. The 2306 leg's `<Number url="...">`
// points here. When Nathan's iPhone picks up, Twilio fetches this URL
// FIRST and plays the prompt to whoever just answered. Only a human
// pressing 1 advances the call; voicemail can't press a digit, so the
// call won't be "answered" by voicemail and the other DCC legs keep
// ringing.
//
// This solves the voicemail-killing-the-call problem without using
// Answering Machine Detection (AMD), which is only ~92% accurate.
// Press-1-to-accept is 100% deterministic.
//
// Deploy with verify_jwt=false (Twilio webhooks are form-encoded).

const screenedUrl = (req: Request): string => {
  const projectRef =
    Deno.env.get('SUPABASE_URL')?.match(/https:\/\/([^.]+)/)?.[1] || ''
  return `https://${projectRef}.supabase.co/functions/v1/twilio-voice-screen`
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('POST only', { status: 405 })
  }

  const form = await req.formData()
  const digits = form.get('Digits')?.toString() || ''
  const from = form.get('From')?.toString() || ''
  const me = screenedUrl(req)

  // Second request: the user pressed 1 (or didn't).
  if (digits) {
    if (digits === '1') {
      // Empty Response = continue the original Dial verb, bridging the
      // call. Twilio cancels every other simultaneous leg automatically.
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response></Response>`
      return new Response(twiml, {
        status: 200,
        headers: { 'Content-Type': 'text/xml' },
      })
    }
    // Any other digit (or no digit) — hang up this leg without
    // answering the original call. Other legs continue ringing.
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Hangup/>
</Response>`
    return new Response(twiml, {
      status: 200,
      headers: { 'Content-Type': 'text/xml' },
    })
  }

  // First request: prompt + gather. callerName comes through as a custom
  // parameter from the parent twilio-voice flow but Twilio doesn't pass
  // <Number url=> parameters to the screening URL — so we use From.
  const safeFrom = (from || 'an unknown caller')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" timeout="8" action="${me}" method="POST">
    <Say voice="Polly.Joanna">
      Incoming Deal Command Center call from ${safeFrom}. Press 1 to accept.
    </Say>
  </Gather>
  <Hangup/>
</Response>`
  return new Response(twiml, {
    status: 200,
    headers: { 'Content-Type': 'text/xml' },
  })
})
