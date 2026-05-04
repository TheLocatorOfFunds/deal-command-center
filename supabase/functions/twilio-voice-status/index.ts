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

    await maybeSendMissedCallSms(db, row, isMissed);

    // Missed inbound call → return voicemail TwiML so caller can leave a message.
    if (isMissed && row?.direction === 'inbound') {
      return new Response(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">You've reached FundLocators. Please leave a message after the beep and we'll call you right back.</Say>
  <Record maxLength="120" playBeep="true"
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
      .select('id, deal_id, contact_id, from_number, to_number, auto_sms_sent')
      .single();

    await maybeSendMissedCallSms(db, row, isMissed);
  }

  return TWIML_OK;
});

async function maybeSendMissedCallSms(db: ReturnType<typeof createClient>, row: any, isMissed: boolean) {
  if (!row || !isMissed || row.auto_sms_sent) return;

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
