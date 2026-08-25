-- 15-min auto-push for the Core-5 NOD lifecycle (Nathan's 2026-08-25 spec:
-- "every core-5 foreclosure flows to GHL"). Same vault-secret wrapper
-- pattern as ghl-dnd-sync; the bridge's push_nod_batch is bounded (20/run)
-- and only touches new or stage-advanced lifecycle deals.
create or replace function public.run_ghl_nod_autopush()
returns void language plpgsql security definer
set search_path = public, pg_catalog
as $$
declare v_secret text;
begin
  select decrypted_secret into v_secret
  from vault.decrypted_secrets where name = 'ghl_sync_secret' limit 1;
  if v_secret is null then return; end if;
  perform net.http_post(
    url := 'https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/ghl-bridge',
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Ghl-Sync-Secret', v_secret),
    body := '{"action":"push_nod_batch","limit":20}'::jsonb
  );
end $$;

select cron.schedule('ghl-nod-autopush-15min', '7,22,37,52 * * * *', 'select public.run_ghl_nod_autopush()');
