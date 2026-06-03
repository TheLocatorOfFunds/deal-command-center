// Twilio Voice status + recording callback.
//
// This function receives events from Twilio, all POSTed to the same URL.
// We differentiate by which params are present — checked in priority order:
//
//   1. DialCallStatus present → <Dial> action callback; fires when ALL dialed
//      legs complete (timeout, answer, cancel). CallSid = parent call SID.
//      When record="record-from-ringing-dual", Twilio may include RecordingUrl
//      in this SAME POST — so we handle recording here too, then return the
//      appropriate TwiML (voicemail prompt for missed inbound calls).
//      MUST be checked before the standalone recording case.
//
//   2. RecordingUrl present (standalone) → recording is ready from the <Record>
//      voicemail verb (fires asynchronously after the voicemail is saved).
//      Store proxy URL in call_logs. This is the voicemail recording itself.
//
//   3. CallStatus + ParentCallSid present → <Number> statusCallback; fires for
//      every status change on the child (outgoing) call leg. CallSid = child
//      SID, ParentCallSid = parent SID (what's stored in call_logs).
//      We update only on CallStatus=completed|busy|no-answer|failed|canceled.
//
// Deploy with verify_jwt=false (Twilio webhooks carry no Supabase JWT).

import { createClient } from 'jsr:@supabase/supabase-js@2';

const normalizePhone = (p: string): string => {
  const digits = (p || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return p.startsWith('+') ? p : '+' + digits;
};

const BUSINESS_NUMBER = '+15139985440'; // FundLocators / Cincinnati Twilio main

const MISSED_CALL_TEMPLATE = `Hey, it's Nathan with RefundLocators — just saw I missed your call. Reply here and I'll get right back to you, or call again anytime at (513) 998-5440.`;

const TWIML_OK = new Response('<Response/>', {
  status: 200,
  headers: { 'Content-Type': 'text/xml' },
});

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });

  const form = await req.formData();

  const callSid        = form.get('CallSid')?.toString() || '';
  const parentCallSid  = form.get('ParentCallSid')?.toString() || '';
  const callStatus     = form.get('CallStatus')?.toString() || '';       // <Number> statusCallback
  const callDuration   = form.get('CallDuration')?.toString() || '';     // <Number> statusCallback
  const dialStatus     = form.get('DialCallStatus')?.toString() || '';   // <Dial> action
  const dialDuration   = form.get('DialCallDuration')?.toString() || ''; // <Dial> action
  const recordingUrl   = form.get('RecordingUrl')?.toString() || '';
  const recordingSid   = form.get('RecordingSid')?.toString() || '';
  const recordingDuration = form.get('RecordingDuration')?.toString() || '';

  if (!callSid) return TWIML_OK;

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const db = createClient(supabaseUrl, serviceKey);

  // ── Case 1: <Dial> action callback ──────────────────────────────────────
  // MUST come before the standalone recording check. When using
  // record="record-from-ringing-dual", Twilio bundles RecordingUrl into this
  // same POST. If we checked RecordingUrl first we'd return early and never
  // update the call status.
  if (dialStatus) {
    const statusMap: Record<string, string> = {
      answered:    'completed',
      completed:   'completed',
      'no-answer': 'no-answer',
      busy:        'busy',
      failed:      'failed',
      canceled:    'canceled',
    };
    const finalStatus = statusMap[dialStatus] || 'completed';
    const isMissed = ['no-answer', 'busy', 'canceled'].includes(finalStatus);

    // Update call status
    const updatePayload: Record<string, unknown> = {
      status:           isMissed ? 'missed' : finalStatus,
      duration_seconds: Number(dialDuration) || 0,
      ended_at:         new Date().toISOString(),
    };
    // If Twilio bundled the ring recording in this same callback, capture it now.
    if (recordingUrl && recordingSid) {
      updatePayload.recording_url      = `${supabaseUrl}/functions/v1/twilio-recording?sid=${recordingSid}`;
      updatePayload.recording_sid      = recordingSid;
      updatePayload.recording_duration = Number(recordingDuration) || null;
    }

    const { data: row, error: updateErr } = await db.from('call_logs')
      .update(updatePayload)
      .eq('twilio_call_sid', callSid)
      .select('id, deal_id, contact_id, from_number, to_number, auto_sms_sent, direction')
      .single();
    if (updateErr) console.error('call_logs status UPDATE error:', JSON.stringify(updateErr), { callSid, dialStatus, finalStatus });

    await maybeBackfillLink(db, row);
    await maybeSendMissedCallSms(db, row, isMissed);

    // Missed inbound call → either hand off to the Vapi voice agent
    // (if configured) OR fall back to a static voicemail prompt.
    //
    // VAPI_SIP_URI is the credential-specific SIP endpoint from the
    // Vapi dashboard, e.g. sip:+15139985440@abc123.sip.vapi.ai. When
    // unset, we keep the original voicemail behavior — so this Edge
    // Function is safe to ship even before the Vapi account is wired up.
    if (isMissed && row?.direction === 'inbound') {
      const vapiSipUri = Deno.env.get('VAPI_SIP_URI') ?? '';
      if (vapiSipUri) {
        // Hand off to Vapi. Vapi will fire end-of-call-report to
        // /functions/v1/vapi-webhook when the conversation finishes.
        return new Response(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial answerOnBridge="true">
    <Sip>${vapiSipUri}</Sip>
  </Dial>
</Response>`, { status: 200, headers: { 'Content-Type': 'text/xml' } });
      }
      // Fallback: static voicemail prompt + <Record>.
      return new Response(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">You've reached FundLocators. Please leave a message after the beep and we'll call you right back.</Say>
  <Record maxLength="120" playBeep="true"
    transcribe="true"
    transcribeCallback="${supabaseUrl}/functions/v1/twilio-transcription-callback"
    recordingStatusCallback="${supabaseUrl}/functions/v1/twilio-voice-status"
    recordingStatusCallbackMethod="POST"/>
</Response>`, { status: 200, headers: { 'Content-Type': 'text/xml' } });
    }

    return TWIML_OK;
  }

  // ── Case 2: Standalone recording ready (voicemail <Record> callback) ─────
  // Fires asynchronously when the voicemail recording is saved. This is
  // separate from the ring recording — it's the caller's actual message.
  if (recordingUrl) {
    const proxyUrl = `${supabaseUrl}/functions/v1/twilio-recording?sid=${recordingSid}`;
    const { error: recErr } = await db.from('call_logs')
      .update({
        recording_url:      proxyUrl,
        recording_sid:      recordingSid,
        recording_duration: Number(recordingDuration) || null,
      })
      .eq('twilio_call_sid', callSid);
    if (recErr) console.error('call_logs recording UPDATE error:', JSON.stringify(recErr), { callSid, recordingSid });
    return TWIML_OK;
  }

  // ── Case 3: <Number> statusCallback (child call leg) ────────────────────
  // Fires for every status transition on the outgoing (child) call.
  // CallSid = child SID; ParentCallSid = parent SID stored in call_logs.
  // We only act on terminal statuses to avoid premature updates.
  const terminalStatuses = new Set(['completed', 'busy', 'no-answer', 'failed', 'canceled']);
  if (callStatus && parentCallSid && terminalStatuses.has(callStatus)) {
    const isMissed = ['busy', 'no-answer', 'failed', 'canceled'].includes(callStatus);
    const finalStatus = isMissed ? 'missed' : 'completed';

    const { data: row } = await db.from('call_logs')
      .update({
        status:           finalStatus,
        duration_seconds: Number(callDuration) || 0,
        ended_at:         new Date().toISOString(),
      })
      .eq('twilio_call_sid', parentCallSid)
      .select('id, deal_id, contact_id, from_number, to_number, auto_sms_sent, direction')
      .single();

    await maybeBackfillLink(db, row);
    await maybeSendMissedCallSms(db, row, isMissed);
  }

  return TWIML_OK;
});

// The non-business party of the call — what we resolve to a deal/contact.
function counterpartNumber(row: any): string {
  if (row?.direction === 'inbound')  return row.from_number || row.to_number || '';
  if (row?.direction === 'outbound') return row.to_number   || row.from_number || '';
  // direction unknown (Case 3 child-leg select) — pick whichever isn't us.
  if (row?.to_number   && row.to_number   !== BUSINESS_NUMBER) return row.to_number;
  if (row?.from_number && row.from_number !== BUSINESS_NUMBER) return row.from_number;
  return row?.to_number || row?.from_number || '';
}

// Safety net: if a call finalized still unlinked (deal_id null) but its
// counterpart number IS resolvable, link it now. Guarantees nothing that
// CAN map to a deal stays orphaned. Mutates `row` so a subsequent
// missed-call SMS writes to the correct deal/contact thread.
async function maybeBackfillLink(db: ReturnType<typeof createClient>, row: any) {
  if (!row || row.deal_id) return;
  const num = counterpartNumber(row);
  if (!num) return;
  try {
    const { data: link } = await db.rpc('resolve_call_link', { p_number: num });
    const r = Array.isArray(link) ? link[0] : link;
    if (r?.deal_id) {
      const threadKey = r.contact_id
        ? `${r.deal_id}:contact:${r.contact_id}`
        : `${r.deal_id}:phone:${normalizePhone(num)}`;
      await db.from('call_logs').update({
        deal_id:    r.deal_id,
        contact_id: r.contact_id || null,
        thread_key: threadKey,
      }).eq('id', row.id);
      row.deal_id    = r.deal_id;
      row.contact_id = r.contact_id || null;
    }
  } catch (_) {
    // Non-fatal — row stays orphan, still visible in global Call History.
  }
}

async function maybeSendMissedCallSms(db: ReturnType<typeof createClient>, row: any, isMissed: boolean) {
  if (!row || !isMissed || row.auto_sms_sent) return;

  // Only INBOUND missed calls get the courtesy text-back. For an outbound
  // missed call we rang them, so the template ("saw I missed your call")
  // is wrong, and row.from_number would be our own business number.
  if (row.direction !== 'inbound') return;

  const recipient = row.from_number || '';
  if (!recipient) return;

  // DND / deceased / bad-number gate — never auto-text a flagged party.
  // Mirrors the dial-time refuse block in twilio-voice-outbound. Fail SAFE:
  // if we can't verify the recipient, do NOT text (hard rule: never text a
  // real client from a wrong path). Matches by contact_id (reliably set post
  // call-link) AND by phone (E.164 + bare 10-digit) to cover orphan rows.
  const d10 = recipient.replace(/\D/g, '').slice(-10);
  try {
    const { data: flags, error: flagErr } = await db.from('contacts')
      .select('do_not_text, deceased, phone_status')
      .or(`id.eq.${row.contact_id || '00000000-0000-0000-0000-000000000000'},phone.eq.${recipient},phone.eq.${d10}`);
    if (flagErr) return; // fail safe
    const blocked = (flags || []).some((c: any) =>
      c.do_not_text === true
      || c.deceased === true
      || c.phone_status === 'wrong_number'
      || c.phone_status === 'disconnected'
    );
    if (blocked) return;
  } catch (_) {
    return; // fail safe
  }

  const twilioSid   = Deno.env.get('TWILIO_ACCOUNT_SID');
  const twilioToken = Deno.env.get('TWILIO_AUTH_TOKEN');
  if (!twilioSid || !twilioToken) return;

  try {
    const resp = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + btoa(`${twilioSid}:${twilioToken}`),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          To:   row.from_number,
          From: row.to_number,
          Body: MISSED_CALL_TEMPLATE,
        }).toString(),
      }
    );
    if (!resp.ok) return;

    const body = await resp.json();
    await db.from('call_logs').update({ auto_sms_sent: true }).eq('id', row.id);
    await db.from('messages_outbound').insert({
      deal_id:    row.deal_id,
      contact_id: row.contact_id,
      thread_key: row.contact_id
        ? `${row.deal_id}:contact:${row.contact_id}`
        : `${row.deal_id}:phone:${normalizePhone(row.from_number)}`,
      direction:   'outbound',
      channel:     'sms',
      from_number: row.to_number,
      to_number:   row.from_number,
      body:        MISSED_CALL_TEMPLATE,
      status:      'sent',
      twilio_sid:  body.sid,
    });
  } catch (_) {
    // Non-fatal
  }
}
