// summarize-call
//
// Phase 4 (F1) of the 5/27 comms redesign. Given a call_logs id with a
// transcript, asks Claude for a 1-2 sentence "who + what about" summary and
// writes it to call_logs.summary. The summary then flows into Case
// Intelligence (generate-case-summary reads call_logs.summary) and shows in
// the Communications Calls tab + the deal's CallRecordings list.
//
// Invoked two ways:
//   - by twilio-transcription-callback right after a transcript lands
//   - manually (re-summarize) with { call_id } from the UI
//
// Request body: { call_id }
// Response:     { summary, generated_at } | { error }

import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const SYSTEM_PROMPT = `You summarize a single phone call for a real-estate surplus-recovery CRM.
Given the call metadata and transcript, output ONE or TWO sentences:
- WHO the call was with (use the contact name if provided, else describe by role/number)
- WHAT it was about and any outcome or next step

Be concrete and factual. No preamble, no "this call was about" filler. If the
transcript is empty, too short, or just voicemail/no-answer, say so in a few
words (e.g. "No answer — went to voicemail" or "Too brief to summarize").`;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('POST only', { status: 405, headers: corsHeaders });

  try {
    const { call_id } = await req.json() as { call_id: string };
    if (!call_id) return new Response(JSON.stringify({ error: 'call_id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!anthropicKey) return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY missing' }), { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const db = createClient(supabaseUrl, serviceKey);

    const { data: call } = await db.from('call_logs')
      .select('id, direction, from_number, to_number, status, duration_seconds, transcript, contact_id, deal_id, contacts(name), deals(name)')
      .eq('id', call_id)
      .single();
    if (!call) return new Response(JSON.stringify({ error: 'call not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const who = (call.contacts as any)?.name
      || (call.direction === 'inbound' ? call.from_number : call.to_number)
      || 'unknown number';

    // No transcript → write a metadata-only summary instead of calling Claude.
    const transcript = (call.transcript || '').trim();
    if (!transcript) {
      const fallback = `${call.direction === 'inbound' ? 'Inbound' : 'Outbound'} call with ${who} — ${call.status || 'no status'}${call.duration_seconds ? `, ${call.duration_seconds}s` : ''}. No transcript.`;
      await db.from('call_logs').update({ summary: fallback, summary_generated_at: new Date().toISOString() }).eq('id', call_id);
      return new Response(JSON.stringify({ summary: fallback, generated_at: new Date().toISOString() }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const userMsg = `Call metadata:
- Direction: ${call.direction}
- With: ${who}${(call.deals as any)?.name ? ` (deal: ${(call.deals as any).name})` : ''}
- Status: ${call.status || 'n/a'}
- Duration: ${call.duration_seconds || 0}s

Transcript:
"""
${transcript.slice(0, 6000)}
"""`;

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 200,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMsg }],
      }),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      return new Response(JSON.stringify({ error: 'Claude API failed', detail: detail.slice(0, 300) }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    const apiBody = await resp.json();
    const summary = (apiBody.content || []).map((b: any) => b.text || '').join('').trim();
    const generatedAt = new Date().toISOString();

    await db.from('call_logs').update({ summary, summary_generated_at: generatedAt }).eq('id', call_id);

    return new Response(JSON.stringify({ summary, generated_at: generatedAt }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
