-- Castle health daily — scheduled "agent" that reviews v_scraper_health
-- once a day, stores a snapshot, and emails an operator on issues.
--
-- Lives entirely in DCC infra (pg_cron + Edge Function + Resend). The
-- Edge Function calls Claude API for the AI judgment that decides:
--   - 🟢 all green → log only, no email
--   - ⚠ transient yellow → log + low-priority email
--   - 🟡 chronic yellow (2+ days same agent) → log + needs-attention email
--   - 🔴 red / never_run on enabled agent → log + URGENT email
--
-- Prerequisites (set before applying):
--   1. Edge Function 'castle-health-daily' deployed with verify_jwt=false
--   2. CASTLE_HEALTH_DAILY_SECRET env var set on the Edge Function (openssl rand -hex 32)
--   3. Same value stored in vault as 'castle_health_daily_secret'
--   4. CASTLE_HEALTH_RECIPIENT env var set on the Edge Function (the email
--      address that receives the alert — change without redeploy by editing
--      this secret in Supabase Dashboard). Defaults to nathan@fundlocators.com.
--   5. ANTHROPIC_API_KEY + RESEND_API_KEY env vars (already set for other functions)

create table if not exists public.castle_health_log (
  id              uuid primary key default gen_random_uuid(),
  snapshot_at     timestamptz not null default now(),
  snapshot_date   date not null default current_date,
  agents          jsonb not null,            -- snapshot of v_scraper_health rows
  any_issues      boolean not null,          -- true if any agent yellow/red/never_run/disabled-shouldnt-be
  severity        text not null              -- 'green' | 'transient' | 'chronic' | 'critical'
                  check (severity in ('green', 'transient', 'chronic', 'critical')),
  summary         text,                      -- Claude's prose summary
  recommendations jsonb,                     -- {actions: [...], priority: 'low'|'med'|'high'}
  email_sent      boolean default false,
  email_recipient text
);

create index if not exists idx_castle_health_log_date on public.castle_health_log(snapshot_date desc);
create index if not exists idx_castle_health_log_severity on public.castle_health_log(severity, snapshot_at desc) where severity != 'green';

alter table public.castle_health_log enable row level security;

drop policy if exists admin_all_castle_health_log on public.castle_health_log;
create policy admin_all_castle_health_log on public.castle_health_log
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

comment on table public.castle_health_log is
  'Daily snapshot + AI summary of Castle scraper fleet health. Written by the castle-health-daily Edge Function. Used to detect chronic vs transient issues across days.';

-- Schedule: 13:00 UTC daily = 9am EDT / 8am EST. One hour after morning-sweep
-- so they don't share infra and so Castle has time to log a fresh heartbeat
-- before we evaluate.
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

do $$ begin
  if exists (select 1 from cron.job where jobname = 'castle-health-daily') then
    perform cron.unschedule('castle-health-daily');
  end if;
end $$;

select cron.schedule(
  'castle-health-daily',
  '0 13 * * *',
  $sql$
  select
    net.http_post(
      url := 'https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/castle-health-daily',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'X-Castle-Health-Daily-Secret',
          (select decrypted_secret from vault.decrypted_secrets where name = 'castle_health_daily_secret' limit 1)
      ),
      body := '{}'::jsonb
    );
  $sql$
);
