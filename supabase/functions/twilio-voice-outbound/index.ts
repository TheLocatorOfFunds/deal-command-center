// twilio-voice-outbound — TwiML App Voice URL for browser-initiated calls.
//
// When the DCC browser SDK calls device.connect({ params: { To, CallerId } }),
// Twilio POSTs here and we return TwiML that dials the destination number
// using Nathan's business number as the caller ID.
//
// Configure in Twilio Console:
//   TwiML Apps → [your app] → Voice → Request URL → POST this function's URL
//
// Deploy with verify_jwt=false (Twilio webhooks don't send Supabase JWTs).

import { createClient } from 'jsr:@supabase/supabase-js@2';

const BUSINESS_NUMBER = '+15139985440'; // Cincinnati Twilio number (FundLocators Main)
const NATHAN_IPHONE   = '+15135162306'; // Nathan's personal iPhone (for inbound forwarding only)
const PROJECT_REF     = 'rcfaashkfpurkvtmsmeb';
const STATUS_CB_URL   = `https://${PROJECT_REF}.supabase.co/functions/v1/twilio-voice-status`;

const normalizePhone = (p: string): string => {
  const digits = (p || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return p.startsWith('+') ? p : '+' + digits;
};

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('POST only', { status: 405 });
  }

  const form      = await req.formData();
  const to        = normalizePhone(form.get('To')?.toString() || '');
  const callSid   = form.get('CallSid')?.toString() || '';
  const callerId  = form.get('CallerId')?.toString() || BUSINESS_NUMBER;

  if (!to) {
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Missing destination number.</Say></Response>`,
      { status: 200, headers: { 'Content-Type': 'text/xml' } }
    );
  }

  // Log the outbound call in call_logs so it appears in the DCC thread.
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const db = createClient(supabaseUrl, serviceKey);

    // Route: find deal + contact by `to` number (same as inbound routing)
    let dealId: string | null = null;
    let contactId: string | null = null;
    let threadKey: string | null = null;

    const { data: contactRows } = await db.from('contacts')
      .select('id, contact_deals(deal_id)')
      .or(`phone.eq.${to},phone.eq.${to.replace('+1', '')}`);
    const match = (contactRows || []).find((c: any) => c.contact_deals?.length > 0);
    if (match) {
      contactId = match.id;
      dealId    = match.contact_deals[0].deal_id;
      threadKey = `${dealId}:contact:${contactId}`;
    }

    if (!dealId) {
      const { data } = await db.rpc('find_deal_by_phone', {
        phone_e164: to,
        phone_bare: to.replace('+', '').replace(/^1/, ''),
      });
      if (data?.[0]?.id) {
        dealId    = data[0].id;
        threadKey = `${dealId}:phone:${to}`;
      }
    }

    await db.from('call_logs').insert({
      deal_id:         dealId,
      contact_id:      contactId,
      thread_key:      threadKey,
      direction:       'outbound',
      from_number:     BUSINESS_NUMBER,
      to_number:       to,
      status:          'ringing',
      twilio_call_sid: callSid,
      started_at:      new Date().toISOString(),
    });
  } catch (_) {
    // Non-fatal — logging failure shouldn't block the call
  }

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial
    callerId="${BUSINESS_NUMBER}"
    action="${STATUS_CB_URL}"
    method="POST"
    timeout="30"
    record="record-from-answer-dual"
    recordingStatusCallback="${STATUS_CB_URL}"
    recordingStatusCallbackMethod="POST"
  >
    <Number statusCallback="${STATUS_CB_URL}" statusCallbackMethod="POST">${to}</Number>
  </Dial>
</Response>`;

  return new Response(twiml, {
    status: 200,
    headers: { 'Content-Type': 'text/xml' },
  });
});
