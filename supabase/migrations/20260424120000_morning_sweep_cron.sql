-- Morning sweep — scheduled 8am EDT / 7am EST (12:00 UTC) daily.
-- Fires the morning-sweep Edge Function which:
--   1. Walks every active deal (status NOT IN closed/recovered/dead)
--   2. Detects overnight activity (24h window on messages/calls/emails/docket/notes/activity)
--   3. Refreshes generate-case-summary for each deal with overnight changes
--   4. Claude composes a cross-deal briefing
--   5. Sends SMS (short) + email (full) to Nathan
--
-- Late-stage surplus deals (filed / awaiting-distribution / probate / paid-out)
-- with NO overnight activity collapse to one line — "Casey Jennings · filed · 47d ago"
-- — instead of spamming the digest daily. Nathan-approved scope on 2026-04-24.
--
-- Prerequisites (set before applying this migration):
--   1. Edge Function 'morning-sweep' deployed with verify_jwt=false
--   2. MORNING_SWEEP_SECRET env var set on the Edge Function (generate with
--      `openssl rand -hex 32` and set in Supabase Dashboard → Edge Functions → Secrets)
--   3. Same value stored in vault as 'morning_sweep_secret' — the cron reads it from there

-- Ensure pg_cron + pg_net extensions exist (they should already be enabled)
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

-- Remove any prior schedule so re-runs are idempotent
do $$ begin
  if exists (select 1 from cron.job where jobname = 'morning-sweep-daily') then
    perform cron.unschedule('morning-sweep-daily');
  end if;
end $$;

-- Schedule: 12:00 UTC daily = 8am EDT (7am EST).
-- Weekdays only could be '0 12 * * 1-5'; daily is '0 12 * * *'. Daily for now.
select cron.schedule(
  'morning-sweep-daily',
  '0 12 * * *',
  $sql$
  select
    net.http_post(
      url := 'https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/morning-sweep',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'X-Morning-Sweep-Secret',
          (select decrypted_secret from vault.decrypted_secrets where name = 'morning_sweep_secret' limit 1)
      ),
      body := '{}'::jsonb
    );
  $sql$
);

comment on function cron.schedule(text, text, text) is
  'Morning sweep registered here runs daily at 12:00 UTC. See supabase/functions/morning-sweep for the handler. Shared secret in vault under morning_sweep_secret.';
