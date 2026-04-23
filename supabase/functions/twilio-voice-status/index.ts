// Twilio Voice status + recording callback.
//
// Twilio POSTs here after the <Dial> completes AND when the recording is
// processed (two separate events, same URL — differentiate by the presence
// of RecordingUrl vs DialCallStatus). We:
//   1. Update the call_logs row with final status + duration.
//   2. Attach the recording URL when Twilio delivers it.
//   3. If the call was missed (no-answer / busy), fire the auto-SMS back.
//
// Deploy with verify_jwt=false.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const normalizePhone = (p: string): string => {
  const digits = (p || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return p.startsWith('+') ? p : '+' + digits;
};

const MISSED_CALL_TEMPLATE = `Hey, it's Nathan with RefundLocators — just saw I missed your call. Reply here and I'll get right back to you, or call again anytime at (513) 516-2306.`;

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });

  const form = await req.formData();
  const callSid = form.get('CallSid')?.toString() || '';
  const dialStatus = form.get('DialCallStatus')?.toString() || '';
  const dialDuration = form.get('DialCallDuration')?.toString() || '';
  const recordingUrl = form.get('RecordingUrl')?.toString() || '';
  const recordingSid = form.get('RecordingSid')?.toString() || '';
  const recordingDuration = form.get('RecordingDuration')?.toString() || '';

  if (!callSid) return new Response('<Response/>', { status: 200, headers: { 'Content-Type': 'text/xml' } });

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const db = createClient(supabaseUrl, serviceKey);

  // Recording callback — Twilio delivers these separately, sometimes later.
  if (recordingUrl) {
    await db.from('call_logs')
      .update({
        recording_url: recordingUrl + '.mp3',
        recording_sid: recordingSid,
        recording_duration: Number(recordingDuration) || null,
      })
      .eq('twilio_call_sid', callSid);
    return new Response('<Response/>', { status: 200, headers: { 'Content-Type': 'text/xml' } });
  }

  // Status callback — final state of the call
  const statusMap: Record<string, string> = {
    'answered':   'completed',
    'completed':  'completed',
    'no-answer':  'no-answer',
    'busy':       'busy',
    'failed':     'failed',
    'canceled':   'canceled',
  };
  const finalStatus = statusMap[dialStatus] || 'completed';
  const isMissed = ['no-answer', 'busy', 'canceled'].includes(finalStatus);

  const { data: row } = await db.from('call_logs')
    .update({
      status: isMissed ? 'missed' : finalStatus,
      duration_seconds: Number(dialDuration) || 0,
      ended_at: new Date().toISOString(),
    })
    .eq('twilio_call_sid', callSid)
    .select('id, deal_id, contact_id, from_number, to_number, auto_sms_sent')
    .single();

  // Missed-call auto-SMS back to the caller. Only send once per call.
  if (row && isMissed && !row.auto_sms_sent) {
    const twilioSid = Deno.env.get('TWILIO_ACCOUNT_SID');
    const twilioToken = Deno.env.get('TWILIO_AUTH_TOKEN');
    if (twilioSid && twilioToken) {
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
              To: row.from_number,
              From: row.to_number,
              Body: MISSED_CALL_TEMPLATE,
            }).toString(),
          }
        );
        if (resp.ok) {
          const body = await resp.json();
          await db.from('call_logs').update({ auto_sms_sent: true }).eq('id', row.id);
          // Also log the auto-SMS as a normal messages_outbound row so it
          // shows up in the Comms thread alongside the missed-call bubble.
          await db.from('messages_outbound').insert({
            deal_id: row.deal_id,
            contact_id: row.contact_id,
            thread_key: row.contact_id
              ? `${row.deal_id}:contact:${row.contact_id}`
              : `${row.deal_id}:phone:${normalizePhone(row.from_number)}`,
            direction: 'outbound',
            channel: 'sms',
            from_number: row.to_number,
            to_number: row.from_number,
            body: MISSED_CALL_TEMPLATE,
            status: 'sent',
            twilio_sid: body.sid,
          });
        }
      } catch (_) {
        // Non-fatal — we still logged the missed call itself
      }
    }
  }

  return new Response('<Response/>', { status: 200, headers: { 'Content-Type': 'text/xml' } });
});
