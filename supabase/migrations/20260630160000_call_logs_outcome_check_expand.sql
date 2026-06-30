-- Expand call_logs.outcome CHECK to include the dispositions added 2026-06-29:
-- booked / not_interested / do_not_call / other.
--
-- ROOT CAUSE of "Other doesn't save" (Eric, 2026-06-30): the original constraint
-- only allowed the first 5 codes (connected/voicemail/no_answer/wrong_number/
-- disconnected). The four newer disposition options violated the CHECK, so the
-- UPDATE in CallDispositionModal.pick() failed — and because that update had no
-- error check, the violation was swallowed and the modal just closed. booked +
-- do_not_call + not_interested had been silently failing the same way.
--
-- v_call_tracker already references booked / not_interested / do_not_call, so this
-- aligns the write-side constraint with the read-side view. Pure widening — every
-- previously-valid value stays valid, existing data untouched.
alter table public.call_logs drop constraint if exists call_logs_outcome_check;
alter table public.call_logs add constraint call_logs_outcome_check
  check (outcome is null or outcome = any (array[
    'connected','voicemail','no_answer','wrong_number','disconnected',
    'booked','not_interested','do_not_call','other'
  ]::text[]));
