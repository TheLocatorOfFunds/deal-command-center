// twilio-transcription-callback
//
// Phase 4 (F1) of the 5/27 comms redesign. Receives Twilio's built-in
// transcription webhook (the `transcribeCallback` target on a <Record>, or a
// Recording transcription callback). Stores the transcript text on the
// matching call_logs row, then fires summarize-call to generate the 1-2
// sentence "who + what about" summary that flows into Case Intelligence.
//
// Twilio POSTs form-encoded:
//   TranscriptionText, TranscriptionStatus, RecordingSid, CallSid, ...
//
// Deploy with --no-verify-jwt (Twilio sends no JWT). Configure the
// transcribeCallback URL on the <Record> verb (see twilio-voice-status) and/or
// enable transcription on call recordings in the Twilio Console pointed here.

import { createClient } from 'jsr:@supabase/supabase-js@2';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' } });
  }
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const db = createClient(supabaseUrl, serviceKey);

    const params = new URLSearchParams(await req.text());
    const transcript = params.get('TranscriptionText') ?? '';
    const status     = params.get('TranscriptionStatus') ?? '';
    const recSid     = params.get('RecordingSid') ?? '';
    const callSid    = params.get('CallSid') ?? '';

    // Resolve the call_logs row by Twilio call SID first (most reliable), then
    // fall back to matching the recording proxy URL by recording SID.
    let callId: string | null = null;
    if (callSid) {
      const { data } = await db.from('call_logs').select('id').eq('twilio_call_sid', callSid).maybeSingle();
      callId = data?.id ?? null;
    }
    if (!callId && recSid) {
      const { data } = await db.from('call_logs').select('id').ilike('recording_url', `%${recSid}%`).maybeSingle();
      callId = data?.id ?? null;
    }

    if (!callId) {
      // Nothing to attach to — ack so Twilio doesn't retry forever.
      return new Response('<Response/>', { headers: { 'Content-Type': 'text/xml' } });
    }

    // Store the transcript (even if failed/empty, so we don't re-poll).
    await db.from('call_logs')
      .update({ transcript: status === 'completed' ? transcript : (transcript || `[transcription ${status}]`) })
      .eq('id', callId);

    // Fire-and-forget the summarizer (don't block Twilio's callback on Claude).
    const projectRef = supabaseUrl.match(/https:\/\/([^.]+)/)?.[1] || '';
    fetch(`https://${projectRef}.supabase.co/functions/v1/summarize-call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${serviceKey}` },
      body: JSON.stringify({ call_id: callId }),
    }).catch(() => {});

    return new Response('<Response/>', { headers: { 'Content-Type': 'text/xml' } });
  } catch (e) {
    console.error('twilio-transcription-callback error:', (e as Error).message);
    return new Response('<Response/>', { headers: { 'Content-Type': 'text/xml' } });
  }
});
