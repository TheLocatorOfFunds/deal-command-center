-- system_alerts — in-app error/warning queue for EFs, triggers, and crons.
--
-- Per Nathan 2026-04-30: too many silent failures hit users this week
-- (Lauren CORS, attach-docket-pdf trigger no-op, several others) before
-- anyone noticed. There's no Sentry / Logflare today. This table gives
-- us an in-DCC "tell me when something broke" surface.
--
-- Producers: Edge Functions call public.report_system_alert() in their
-- catch blocks. pg_cron failures get swept by a poll job (added below).
-- Triggers / Postgres functions can call the RPC directly too.
--
-- Consumers: DCC header renders a ⚠ badge with the unacked count;
-- modal lists the alerts with severity + source + message + context.

create table if not exists public.system_alerts (
  id uuid primary key default gen_random_uuid(),
  severity text not null default 'error'
    check (severity in ('info','warning','error','critical')),
  source text not null,                 -- e.g. 'attach-docket-pdf', 'intel-sync', 'pg_cron:morning-sweep-daily'
  message text not null,                -- short human-readable summary
  context jsonb not null default '{}'::jsonb,  -- stack, deal_id, request body, etc.
  fingerprint text,                     -- for dedup (severity + source + message hash typically)
  occurrences integer not null default 1,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  acknowledged_by uuid references auth.users(id),
  resolved_at timestamptz,              -- optional separate state for "fixed", different from "ack'd"
  created_at timestamptz not null default now()
);

create index if not exists idx_system_alerts_unack
  on public.system_alerts(last_seen_at desc)
  where acknowledged_at is null;
create unique index if not exists idx_system_alerts_fingerprint_unack
  on public.system_alerts(fingerprint)
  where acknowledged_at is null and fingerprint is not null;

alter table public.system_alerts enable row level security;

drop policy if exists "owners read system_alerts" on public.system_alerts;
create policy "owners read system_alerts"
  on public.system_alerts for select
  using (public.is_admin());

drop policy if exists "owners ack system_alerts" on public.system_alerts;
create policy "owners ack system_alerts"
  on public.system_alerts for update
  using (public.is_admin());

-- ── Producer RPC ────────────────────────────────────────────────────────
-- Idempotent by fingerprint: if an unacked row with the same fingerprint
-- exists, bump occurrences + last_seen_at instead of inserting a duplicate.
-- That keeps the alerts list short during a crash loop.
create or replace function public.report_system_alert(
  p_source text,
  p_message text,
  p_severity text default 'error',
  p_context jsonb default '{}'::jsonb,
  p_fingerprint text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fp text := coalesce(p_fingerprint, p_severity || ':' || p_source || ':' || left(p_message, 100));
  v_id uuid;
begin
  insert into public.system_alerts (severity, source, message, context, fingerprint)
  values (p_severity, p_source, p_message, coalesce(p_context, '{}'::jsonb), v_fp)
  on conflict (fingerprint) where acknowledged_at is null and fingerprint is not null
  do update set
    occurrences = system_alerts.occurrences + 1,
    last_seen_at = now(),
    -- merge new context with old (new wins on conflict)
    context = system_alerts.context || excluded.context
  returning id into v_id;
  return v_id;
end;
$$;

grant execute on function public.report_system_alert(text, text, text, jsonb, text) to authenticated, service_role;

-- ── Acknowledge RPC ─────────────────────────────────────────────────────
create or replace function public.acknowledge_system_alert(p_alert_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  update public.system_alerts
    set acknowledged_at = now(), acknowledged_by = auth.uid()
    where id = p_alert_id and acknowledged_at is null;
end;
$$;

grant execute on function public.acknowledge_system_alert(uuid) to authenticated;

create or replace function public.acknowledge_all_system_alerts()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_count integer;
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  update public.system_alerts
    set acknowledged_at = now(), acknowledged_by = auth.uid()
    where acknowledged_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

grant execute on function public.acknowledge_all_system_alerts() to authenticated;

-- ── pg_cron failure sweeper ─────────────────────────────────────────────
-- Read cron.job_run_details for failures in the last hour and report
-- them as alerts. Idempotent by run_id-as-fingerprint so re-running
-- the sweep doesn't re-alert the same failure. Runs every 5 min via
-- pg_cron itself.
create or replace function public.sweep_cron_failures()
returns integer
language plpgsql
security definer
set search_path = public, cron
as $$
declare
  v_count integer := 0;
  v_row record;
begin
  for v_row in
    select jrd.runid, jrd.jobid, jrd.start_time, jrd.end_time, jrd.return_message,
           j.jobname
    from cron.job_run_details jrd
    join cron.job j on j.jobid = jrd.jobid
    where jrd.status = 'failed'
      and jrd.end_time > now() - interval '1 hour'
  loop
    perform public.report_system_alert(
      p_source     := 'pg_cron:' || v_row.jobname,
      p_severity   := 'error',
      p_message    := left(coalesce(v_row.return_message, 'cron job failed'), 300),
      p_context    := jsonb_build_object(
                        'runid', v_row.runid,
                        'jobid', v_row.jobid,
                        'jobname', v_row.jobname,
                        'start_time', v_row.start_time,
                        'end_time', v_row.end_time
                      ),
      p_fingerprint := 'pg_cron_run:' || v_row.runid
    );
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- Schedule the sweep every 5 min. Idempotent — schedule() is upsert-by-name.
select cron.schedule(
  'sweep-cron-failures-5min',
  '*/5 * * * *',
  $sql$ select public.sweep_cron_failures(); $sql$
);

comment on table public.system_alerts is
  'In-DCC error queue. EFs / triggers / cron jobs report failures via public.report_system_alert. Header badge + modal in DCC surface unacked alerts to admins. Replaces the ''found bugs by accident days later'' pattern.';
