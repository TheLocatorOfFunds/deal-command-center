-- Drop A2P 10DLC campaign-status monitoring infrastructure.
--
-- The campaign on +15139985440 was VERIFIED on 2026-05-24, and the
-- daily auto-check that lived behind this scaffolding has fulfilled
-- its purpose. The cron job was already removed at some point before
-- this migration; this drops the supporting table, RPC, and Vault
-- secret.
--
-- The Edge Function `check-a2p-campaign-status` is being replaced
-- with a 410 Gone stub in the same change set (deployed separately,
-- since Edge Functions aren't tracked in migrations).
--
-- If you ever need to monitor A2P campaign status again, recreate
-- the table + function + Vault secret + cron job; the original
-- migration is in git history at
-- supabase/migrations/20260506200000_a2p_campaign_status_check.sql
-- (if that file was ever committed — it appears it was applied
-- directly via SQL editor, no committed source).

begin;

-- Belt-and-suspenders cron cleanup. The job is already gone as of
-- 2026-05-26 inventory but this makes the intent explicit and the
-- migration idempotent if a future operator recreates it.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'a2p-campaign-status-check') then
    perform cron.unschedule('a2p-campaign-status-check');
  end if;
end$$;

drop table if exists public.a2p_campaign_status_log;

drop function if exists public.verify_a2p_status_secret(text);

-- Vault secret cleanup. vault.secrets is a managed table — delete by name
-- is the supported pattern.
delete from vault.secrets where name = 'a2p_status_check_secret';

commit;
