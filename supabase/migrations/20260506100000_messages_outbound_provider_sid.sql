-- RVM delivery integration — Slybroadcast (and any future RVM/voice provider)
-- needs a place to store its session/transaction ID. `twilio_sid` is the
-- Twilio-specific column; we add a generic `provider_sid` for non-Twilio
-- providers so the namespace stays clean.
--
-- Slybroadcast returns a session_id on every successful POST (one session
-- can cover multiple recipients in a batch — for now we batch=1, but the
-- column is wide enough for the future case where we drop a campaign).

alter table public.messages_outbound
  add column if not exists provider_sid text;

create index if not exists messages_outbound_provider_sid_idx
  on public.messages_outbound (provider_sid)
  where provider_sid is not null;
