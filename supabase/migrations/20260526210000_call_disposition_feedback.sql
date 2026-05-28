-- Post-call disposition feedback (Issue #244).
--
-- After every outbound call, the operator sees a CallDispositionModal
-- in the web UI with 5 V1 options. The chosen outcome lands here on
-- call_logs (per-call audit trail), and certain outcomes propagate
-- to contacts.phone_status (current state of this number).
--
-- Dispositions in V1:
--   connected     -> spoke to homeowner; phone_status='good'
--   voicemail     -> left a voicemail; no phone-level effect
--   no_answer     -> nobody picked up; no phone-level effect
--   wrong_number  -> reached someone else; phone_status='wrong_number',
--                    auto-block future calls + SMS to this number
--   disconnected  -> "this number is no longer in service";
--                    phone_status='disconnected', auto-block future
--                    calls + SMS, also flips contacts.do_not_call=true
--
-- Per-call edits: operator can click the disposition badge on a
-- past call_logs row to reopen the modal and correct mistakes.

begin;

-- ── call_logs.outcome ─────────────────────────────────────────────
alter table public.call_logs
  add column if not exists outcome text,
  add column if not exists outcome_set_at timestamptz,
  add column if not exists outcome_set_by uuid references auth.users (id) on delete set null;

-- V1 constraint scope. Add to the allowed set when we expand
-- (deceased, busy, callback, do_not_call from the full GHL parity list).
alter table public.call_logs
  drop constraint if exists call_logs_outcome_check;

alter table public.call_logs
  add constraint call_logs_outcome_check
  check (outcome is null or outcome in (
    'connected',
    'voicemail',
    'no_answer',
    'wrong_number',
    'disconnected'
  ));

create index if not exists call_logs_outcome_idx
  on public.call_logs (outcome)
  where outcome is not null;

comment on column public.call_logs.outcome is
  'Operator-entered disposition from the post-call modal. NULL until the operator selects one. V1 scope: connected | voicemail | no_answer | wrong_number | disconnected.';

-- ── contacts.phone_status ─────────────────────────────────────────
alter table public.contacts
  add column if not exists phone_status text,
  add column if not exists phone_status_set_at timestamptz;

alter table public.contacts
  drop constraint if exists contacts_phone_status_check;

alter table public.contacts
  add constraint contacts_phone_status_check
  check (phone_status is null or phone_status in (
    'good',
    'wrong_number',
    'disconnected'
  ));

create index if not exists contacts_phone_status_idx
  on public.contacts (phone_status)
  where phone_status is not null;

comment on column public.contacts.phone_status is
  'Current state of this contact''s phone number, set by the post-call disposition modal. NULL = unknown. ''good'' = last confirmed-connected call succeeded. ''wrong_number'' or ''disconnected'' = future SMS + voice are auto-blocked by send-sms and twilio-voice-outbound.';

commit;
