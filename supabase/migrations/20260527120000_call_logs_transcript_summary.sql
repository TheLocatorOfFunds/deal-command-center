-- ─────────────────────────────────────────────────────────────────────
-- 20260527120000_call_logs_transcript_summary
--
-- Phase 4 (F1) of the 5/27 comms redesign: feed call content into Case
-- Intelligence. Adds transcript + AI-summary columns to call_logs so a
-- call's "who + what it was about" can be surfaced on the deal and folded
-- into generate-case-summary.
--
--   transcript            — raw text from Twilio's built-in transcription
--                           (TranscriptionText posted by the transcribe
--                           callback). Nullable; many calls won't transcribe.
--   summary               — 1-2 sentence Claude summary of the transcript
--                           ("Spoke with the daughter; she confirmed the
--                            homeowner is deceased and is open to a call").
--   summary_generated_at  — when summarize-call last wrote the summary.
--
-- No RLS changes — call_logs already inherits the deal-scoped policies.
-- ─────────────────────────────────────────────────────────────────────

alter table public.call_logs
  add column if not exists transcript           text,
  add column if not exists summary               text,
  add column if not exists summary_generated_at  timestamptz;

comment on column public.call_logs.transcript is
  'Raw transcription text from Twilio built-in transcription (transcribe callback). Nullable.';
comment on column public.call_logs.summary is
  'Claude 1-2 sentence summary of the call (who + what about). Written by the summarize-call edge function.';
comment on column public.call_logs.summary_generated_at is
  'Timestamp of the last summarize-call write.';
