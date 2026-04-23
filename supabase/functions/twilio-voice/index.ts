// Twilio Voice inbound entry point.
//
// Twilio POSTs here when a call hits one of our DCC-managed numbers. We:
//   1. Route the inbound caller to the right deal + contact (same logic as
//      receive-sms: contacts.phone → contact_deals → deal).
//   2. Create a call_logs row in 'ringing' state so the conversation thread
//      shows the incoming call in real-time.
//   3. Return TwiML that records the call + forwards to Nathan's iPhone.
//      If Nathan doesn't pick up within 18s, Twilio hangs up and the status
//      callback (separate Edge Function) marks it 'no-answer' and triggers
//      the missed-call auto-SMS.
//
// Deploy with verify_jwt=false (Twilio webhooks are form-encoded, no JWT).

import { createClient } from 'jsr:@supabase/supabase-js@2';

const NATHAN_IPHONE = '+15135162306';
const RING_SECONDS = 18;

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

  const form = await req.formData();
  const fromRaw = form.get('From')?.toString() || '';
  const toRaw = form.get('To')?.toString() || '';
  const callSid = form.get('CallSid')?.toString() || '';
  const from = normalizePhone(fromRaw);
  const to = normalizePhone(toRaw);

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const db = createClient(supabaseUrl, serviceKey);

  // Route: contacts.phone → contact_deals → deal. Fallback to homeowner phone.
  let dealId: string | null = null;
  let contactId: string | null = null;
  let threadKey: string | null = null;

  try {
    const { data: contactRows } = await db.from('contacts')
      .select('id, contact_deals(deal_id)')
      .or(`phone.eq.${from},phone.eq.${fromRaw}`);
    const match = (contactRows || []).find((c: any) => c.contact_deals?.length > 0);
    if (match) {
      contactId = match.id;
      dealId = match.contact_deals[0].deal_id;
      threadKey = `${dealId}:contact:${contactId}`;
    }
  } catch (_) {
    // ignore, try fallback
  }

  if (!dealId) {
    // Fallback: homeowner phone lookup via RPC
    try {
      const { data } = await db.rpc('find_deal_by_phone', { phone_e164: from, phone_bare: from.replace('+', '') });
      if (data) {
        dealId = data;
        threadKey = `${dealId}:phone:${from}`;
      }
    } catch (_) {}
  }

  // Log the call in 'ringing' state. The status callback will finalize it.
  const { data: callRow } = await db.from('call_logs').insert({
    deal_id: dealId,
    contact_id: contactId,
    thread_key: threadKey,
    direction: 'inbound',
    from_number: from,
    to_number: to,
    status: 'ringing',
    twilio_call_sid: callSid,
    started_at: new Date().toISOString(),
  }).select('id').single();

  // Edge Function URL for the status callback
  const projectRef = supabaseUrl.match(/https:\/\/([^.]+)/)?.[1] || '';
  const statusUrl = `https://${projectRef}.supabase.co/functions/v1/twilio-voice-status`;

  // TwiML: record the call, dial Nathan, hang up on no-answer after RING_SECONDS
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial
    action="${statusUrl}"
    method="POST"
    timeout="${RING_SECONDS}"
    record="record-from-ringing-dual"
    recordingStatusCallback="${statusUrl}"
    recordingStatusCallbackMethod="POST"
    callerId="${to}"
  >${NATHAN_IPHONE}</Dial>
</Response>`;

  return new Response(twiml, {
    status: 200,
    headers: { 'Content-Type': 'text/xml' },
  });
});
