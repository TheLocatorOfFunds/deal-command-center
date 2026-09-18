-- morning-pulse: daily SMS heartbeat to Nathan (7am ET) + Twilio balance
-- canary. Secret lives in Vault ('pulse_secret'), never in this file.
create or replace function public.fire_morning_pulse() returns bigint
language plpgsql security definer set search_path = public as $$
declare s text; rid bigint;
begin
  select decrypted_secret into s from vault.decrypted_secrets where name = 'pulse_secret' limit 1;
  if s is null then return null; end if;
  select net.http_post(
    url := 'https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/morning-pulse',
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Pulse-Secret', s),
    body := '{}'::jsonb
  ) into rid;
  return rid;
end $$;

select cron.schedule('morning-pulse-sms', '0 11 * * *', $c$ select public.fire_morning_pulse(); $c$);
