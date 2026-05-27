// Twilio Voice inbound entry point.
//
// Twilio POSTs here when a call hits one of our DCC-managed numbers. We:
//   1. Route the inbound caller to the right deal + contact (same logic as
//      receive-sms: contacts.phone → contact_deals → deal).
//   2. Create a call_logs row in 'ringing' state so the conversation thread
//      shows the incoming call in real-time.
//   3. Return TwiML that records the call + forwards to Nathan's iPhone.
//      If Nathan doesn't pick up within RING_SECONDS, the status callback
//      marks it 'no-answer' and triggers the missed-call auto-SMS.
//
// Deploy with verify_jwt=false (Twilio webhooks are form-encoded, no JWT).
//
// COLD-START GUARD: Twilio abandons the TwiML webhook after 15 seconds and
// plays "application error." On Supabase free tier, cold starts can exceed
// that. All DB lookups run in parallel and race against DB_BUDGET_MS so we
// always respond in time. If the budget expires we return TwiML with empty
// metadata — the call still routes correctly to all DCC clients + Nathan.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const RING_SECONDS = 30;
// Must return TwiML before Twilio's 15s webhook timeout. Give DB 8s max so
// we have headroom even on a cold start (createClient + formData parsing ~1s).
const DB_BUDGET_MS = 8000;

// Single shared identity for all DCC browsers AND mobile clients.
// Twilio rings EVERY registered Twilio.Device with this identity simultaneously,
// so all team member browsers + mobile apps ring without any per-user configuration.
// This matches the identity issued by twilio-token.
const DCC_CLIENT_IDENTITIES = ['dcc-fundlocators'];

// Nathan's Spectrum iPhone — always-on safety-net leg that rings in
// parallel with the DCC clients. Screened by twilio-voice-screen so
// voicemail can't "answer" the call and kill the other legs.
const NATHAN_FALLBACK_NUMBER = '+15135162306';

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

  // Run all DB lookups in parallel, raced against a hard deadline.
  // If the DB is slow (cold start), we fall through with null metadata and
  // still return valid TwiML on time. The call routes correctly either way.
  const dbLookup = (async () => {
    // Contact lookup and homeowner-phone RPC run concurrently.
    const [contactResult, phoneResult] = await Promise.all([
      db.from('contacts')
        .select('id, contact_deals(deal_id)')
        .or(`phone.eq.${from},phone.eq.${fromRaw}`)
        .then(r => r.data),
      db.rpc('find_deal_by_phone', { phone_e164: from, phone_bare: from.replace('+', '') })
        .then(r => r.data),
    ]);

    let dealId: string | null = null;
    let contactId: string | null = null;
    let threadKey: string | null = null;

    // Contact match takes priority over homeowner-phone match.
    const match = (contactResult || []).find((c: any) => c.contact_deals?.length > 0);
    if (match) {
      contactId = match.id;
      dealId = match.contact_deals[0].deal_id;
      threadKey = `${dealId}:contact:${contactId}`;
    } else if (phoneResult) {
      // find_deal_by_phone returns RETURNS TABLE [{id}], RETURNS text, or object.
      if (typeof phoneResult === 'string') {
        dealId = phoneResult;
      } else if (Array.isArray(phoneResult) && phoneResult.length > 0) {
        dealId = phoneResult[0]?.id ?? null;
      } else if (typeof phoneResult === 'object' && phoneResult !== null) {
        dealId = (phoneResult as any).id ?? null;
      }
      if (dealId) threadKey = `${dealId}:phone:${from}`;
    }

    // Deal name and call_log insert run concurrently once we have dealId.
    const [dealRow, callLogResult] = await Promise.all([
      dealId
        ? db.from('deals').select('name').eq('id', dealId).single().then(r => r.data)
        : Promise.resolve(null),
      db.from('call_logs').insert({
        deal_id: dealId,
        contact_id: contactId,
        thread_key: threadKey,
        direction: 'inbound',
        from_number: from,
        to_number: to,
        status: 'ringing',
        twilio_call_sid: callSid,
        started_at: new Date().toISOString(),
      }).select('id').single(),
    ]);

    if (callLogResult.error) {
      console.error('call_logs INSERT error:', JSON.stringify(callLogResult.error), { dealId, contactId, from, to, callSid });
    }

    return { dealId, contactId, threadKey, dealName: dealRow?.name ?? null };
  })();

  // Timeout fallback — ensures we always respond before Twilio's 15s limit.
  const deadline = new Promise<{ dealId: null; contactId: null; threadKey: null; dealName: null }>(
    resolve => setTimeout(() => {
      console.warn('[twilio-voice] DB budget exceeded, returning TwiML with empty metadata', { from, callSid });
      resolve({ dealId: null, contactId: null, threadKey: null, dealName: null });
    }, DB_BUDGET_MS)
  );

  const { dealId, contactId, threadKey, dealName } = await Promise.race([dbLookup, deadline]);

  // Edge Function URL for the status callback
  const projectRef = supabaseUrl.match(/https:\/\/([^.]+)/)?.[1] || '';
  const statusUrl = `https://${projectRef}.supabase.co/functions/v1/twilio-voice-status`;
  const screenUrl = `https://${projectRef}.supabase.co/functions/v1/twilio-voice-screen`;

  // Build <Client> entries for every DCC team member browser.
  // All registered browsers with these identities ring simultaneously.
  const safeFrom    = from;  // E.164 — XML-safe
  const safeDealId  = (dealId || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const safeDealName = (dealName || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const safeContactId = (contactId || '').replace(/&/g, '&amp;');

  const clientElements = DCC_CLIENT_IDENTITIES.map(identity => `    <Client>
      <Identity>${identity}</Identity>
      <Parameter name="from" value="${safeFrom}"/>
      <Parameter name="callerName" value="${safeFrom}"/>
      <Parameter name="dealId" value="${safeDealId}"/>
      <Parameter name="dealName" value="${safeDealName}"/>
      <Parameter name="contactId" value="${safeContactId}"/>
    </Client>`).join('\n');

  // TwiML: ring ALL DCC clients (web + mobile) AND Nathan's 2306 in
  // parallel. The <Number> leg is screened by twilio-voice-screen
  // (press-1-to-accept), which prevents voicemail from "answering" the
  // call and killing every other leg before a human picks up.
  //
  // First leg to confirm pickup wins; Twilio cancels the others.
  // If nobody picks up in RING_SECONDS, statusUrl fires with no-answer
  // and the existing missed-call flow handles it.
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
  >
${clientElements}
    <Number url="${screenUrl}" method="POST">${NATHAN_FALLBACK_NUMBER}</Number>
  </Dial>
</Response>`;

  return new Response(twiml, {
    status: 200,
    headers: { 'Content-Type': 'text/xml' },
  });
});
