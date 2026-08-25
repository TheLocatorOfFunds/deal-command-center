-- The reason CHECK predates the wrong-person funnel event (#340). Widen it —
-- the standing gotcha: any new value for a constrained column widens the
-- CHECK in the same change.
alter table public.bad_phone_numbers drop constraint bad_phone_numbers_reason_check;
alter table public.bad_phone_numbers add constraint bad_phone_numbers_reason_check
  check (reason = any (array['disconnected'::text, 'wrong_number'::text, 'do_not_call'::text, 'wrong_person'::text]));
