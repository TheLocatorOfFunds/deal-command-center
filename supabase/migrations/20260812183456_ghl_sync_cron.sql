-- 15-minute heartbeat for the no-contact brain's DND sync (invariant 1).
-- Same vault-secret wrapper pattern as send_payroll_reminder.
create or replace function public.run_ghl_sync()
returns void language plpgsql security definer
set search_path = public, pg_catalog
as $$
declare v_secret text;
begin
  select decrypted_secret into v_secret
  from vault.decrypted_secrets where name = 'ghl_sync_secret' limit 1;
  if v_secret is null then return; end if;
  perform net.http_post(
    url := 'https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/ghl-sync',
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Ghl-Sync-Secret', v_secret),
    body := '{}'::jsonb
  );
end $$;

select cron.schedule('ghl-dnd-sync-15min', '*/15 * * * *', 'select public.run_ghl_sync()');
