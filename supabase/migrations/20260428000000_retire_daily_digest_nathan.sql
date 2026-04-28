-- Retire the legacy `daily-digest-nathan` cron job.
--
-- Audit 2026-04-27 (see docs/SEND_DAILY_DIGEST_AUDIT.md):
--   `daily-digest-nathan`  fires 0 12 * * *  → public.send_daily_digest()
--   `morning-sweep-daily`  fires 0 12 * * *  → Edge Function morning-sweep
--
-- Both at the exact same minute. The Edge Function is the canonical
-- daily 8am EDT digest going forward (richer Claude-written briefing,
-- per-deal AI summaries, per-deal overnight signals, pending-draft
-- review prompts).
--
-- This migration:
--   1. Deactivates `daily-digest-nathan` (reversible — set active=true
--      to bring it back if the new path breaks unexpectedly)
--   2. Leaves public.send_daily_digest() in place. The function's
--      original CREATE migration is missing from git (created via
--      SQL editor), so dropping it loses the implementation. Leave
--      it parked; can drop in a follow-up after a stability window.

update cron.job
set    active = false
where  jobname = 'daily-digest-nathan';

-- Sanity check: verify the morning-sweep cron is still active and
-- nothing else has crept in scheduled at 12:00 UTC.
do $$
declare
  remaining int;
begin
  select count(*) into remaining
  from cron.job
  where active = true and schedule = '0 12 * * *';

  if remaining = 0 then
    raise exception 'No active cron at 12:00 UTC after retirement — aborting';
  end if;

  if remaining > 1 then
    raise notice 'Multiple active crons at 12:00 UTC (% jobs) — review before relying on this migration', remaining;
  end if;
end $$;
