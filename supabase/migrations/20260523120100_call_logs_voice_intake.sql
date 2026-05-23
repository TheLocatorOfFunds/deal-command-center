-- Voice intake columns on call_logs.
--
-- When an inbound call goes unanswered and routes to the Vapi voice
-- agent (see twilio-voice-status Case 1, gated on the VAPI_SIP_URI
-- env var), the vapi-webhook EF stores the call's transcript +
-- Vapi-extracted structured intake on the matching call_logs row.
--
-- Why columns on call_logs (vs. a separate `voice_intakes` table):
-- every voice agent call IS a Twilio call — call_logs already has the
-- deal_id, contact_id, from_number, recording_url, ended_at we need.
-- Putting the intake here keeps the join story simple and lets the
-- existing call card / mobile deal screen render the intake without
-- a second query.

alter table public.call_logs
  add column if not exists voice_provider   text,
  add column if not exists voice_call_id    text,
  add column if not exists voice_transcript text,
  add column if not exists voice_summary    text,
  add column if not exists voice_intake     jsonb,
  add column if not exists voice_cost_cents integer;

comment on column public.call_logs.voice_provider   is 'Voice agent provider that handled the call. ''vapi'' today; reserved so we can pivot to Retell if Vapi flops in pilot.';
comment on column public.call_logs.voice_call_id    is 'Provider-side call ID — Vapi sends it on every event so we can dedupe webhook deliveries.';
comment on column public.call_logs.voice_transcript is 'Full conversation transcript. Plain text; one line per turn (Vapi format).';
comment on column public.call_logs.voice_summary    is 'Provider-generated summary of the call. Cheaper than re-prompting Claude to summarize from the transcript.';
comment on column public.call_logs.voice_intake     is 'Structured-output extraction: { caller_name, county, case_reference, callback_number, urgency, notes }.';
comment on column public.call_logs.voice_cost_cents is 'Cost of THIS call in cents (sum of platform + LLM + TTS + STT + telephony). Lets the morning sweep flag runaway spend without going to the Vapi dashboard.';

-- Quick filter: "find me all agent-handled calls in the last 7 days"
create index if not exists idx_call_logs_voice_provider
  on public.call_logs(voice_provider, created_at desc)
  where voice_provider is not null;

-- Dedup index — provider call_id should uniquely identify the call on
-- the provider side. Partial so legacy rows without a voice_call_id
-- don't break.
create unique index if not exists idx_call_logs_voice_call_id_unique
  on public.call_logs(voice_call_id)
  where voice_call_id is not null;
