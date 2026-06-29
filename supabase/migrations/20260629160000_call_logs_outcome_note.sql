-- Call disposition "Other" + free-text note (Eric request 2026-06-29).
-- Eric hits calls that don't fit Connected/Voicemail/No answer/Wrong number/
-- Disconnected (busy signal, no voicemail set up, generic answering machine,
-- can't confirm the person). Forcing those into Voicemail/Disconnected wrongly
-- blocks SMS/voice or flags DNC on a possibly-live number. The new 'other'
-- disposition is NEUTRAL (no phone_status change, no DNC) and carries a note.
--
-- Column grants on call_logs are column-restricted (not table-wide), so the
-- new column needs an explicit grant or the note write silently fails for
-- authenticated users.
alter table public.call_logs add column if not exists outcome_note text;
grant select (outcome_note), insert (outcome_note), update (outcome_note)
  on public.call_logs to authenticated;
