-- Schedule the intel-sync edge function every 30 minutes.
--
-- Prerequisites (do these BEFORE applying this migration, otherwise the
-- first cron firing will 401 or 500):
--
--   1. Edge function deployed:
--        supabase functions deploy intel-sync --no-verify-jwt
--
--   2. EF secrets set in Supabase Dashboard → Edge Functions → Secrets:
--        INTEL_SUPABASE_URL              — ohio-intel project URL
--        INTEL_SUPABASE_SERVICE_ROLE_KEY — ohio-intel service-role key
--        INTEL_SYNC_SECRET               — random hex (openssl rand -hex 32)
--
--   3. Same INTEL_SYNC_SECRET stored in vault as 'intel_sync_secret'
--      (Supabase Dashboard → Project Settings → Vault → New Secret).
--      The cron reads it from vault to call the EF; the EF reads it from
--      its own env to verify the call. Same value, two different stores.
--
-- Idempotent — re-running unschedules the prior job before re-creating.

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net  with schema extensions;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'intel-sync-30min') then
    perform cron.unschedule('intel-sync-30min');
  end if;
end $$;

-- Every 30 minutes on the :00 and :30 ticks.
select cron.schedule(
  'intel-sync-30min',
  '0,30 * * * *',
  $sql$
  select
    net.http_post(
      url := 'https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/intel-sync',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'X-Intel-Sync-Secret',
          (select decrypted_secret from vault.decrypted_secrets where name = 'intel_sync_secret' limit 1)
      ),
      body := '{}'::jsonb
    );
  $sql$
);

comment on extension pg_cron is
  'Cron jobs registered: morning-sweep-daily (12:00 UTC), intel-sync-30min (every :00/:30). See supabase/functions/intel-sync for the handler.';
