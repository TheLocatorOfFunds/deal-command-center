-- Operator-health page backing fn (#5, Nathan 2026-06-22). One admin glance:
-- AI-credit canary, every active cron's last run + staleness, open system_alerts,
-- scraper health. SECURITY DEFINER so the UI (authenticated role) can read the
-- cron.* schema it otherwise can't. Applied to prod via MCP apply_migration.
create or replace function public.get_operator_health()
returns jsonb
language sql
stable
security definer
set search_path = public, cron
as $$
with
ai as (
  select c.ok, c.fired_at, c.failure_reason,
         round(extract(epoch from (now() - c.fired_at)) / 60)::int as age_min
  from ops_anthropic_canary c
  order by c.fired_at desc
  limit 1
),
cron_last as (
  select j.jobname, j.schedule,
         d.start_time as last_run, d.status as last_status,
         round(extract(epoch from (now() - d.start_time)) / 60)::int as age_min,
         case
           when j.schedule ~ '^(\*|\*/)'   then 180     -- sub-hourly: stale >3h
           when j.schedule ~ ' [0-6]$'     then 11520   -- weekly (specific DOW): >8d
           when j.schedule ~ '^[0-9]+,'    then 180     -- multi-time/hour
           else 1800                                    -- daily: stale >30h
         end as max_age_min
  from cron.job j
  left join lateral (
    select start_time, status from cron.job_run_details r
    where r.jobid = j.jobid order by r.start_time desc limit 1
  ) d on true
  where j.active
),
cron_health as (
  select jobname, schedule, last_run, last_status, age_min,
         case
           when last_run is null                          then 'red'
           when last_status is distinct from 'succeeded'  then 'red'
           when age_min > max_age_min                     then 'amber'
           else 'green'
         end as color
  from cron_last
)
select jsonb_build_object(
  'generated_at', now(),
  'ai_credit', (select jsonb_build_object(
       'ok', ok, 'fired_at', fired_at, 'failure_reason', failure_reason, 'age_min', age_min
     ) from ai),
  'cron_summary', (select jsonb_build_object(
       'red',   count(*) filter (where color = 'red'),
       'amber', count(*) filter (where color = 'amber'),
       'green', count(*) filter (where color = 'green')
     ) from cron_health),
  'crons', (select coalesce(jsonb_agg(to_jsonb(ch)
       order by (case color when 'red' then 0 when 'amber' then 1 else 2 end), jobname), '[]'::jsonb)
     from cron_health ch),
  'alerts', jsonb_build_object(
     'open_count', (select count(*) from system_alerts
                    where resolved_at is null and last_seen_at > now() - interval '7 days'),
     'items', coalesce((select jsonb_agg(x) from (
        select jsonb_build_object(
          'severity', severity, 'source', source, 'message', left(message, 160),
          'occurrences', occurrences, 'last_seen_at', last_seen_at
        ) as x
        from system_alerts
        where resolved_at is null and last_seen_at > now() - interval '7 days'
        order by last_seen_at desc limit 8
     ) q), '[]'::jsonb)
  ),
  'scrapers', (select jsonb_build_object(
       'green', count(*) filter (where health_color = 'green'),
       'amber', count(*) filter (where health_color = 'amber'),
       'red',   count(*) filter (where health_color = 'red'),
       'alerting', coalesce(jsonb_agg(jsonb_build_object(
            'agent', display_name, 'color', health_color,
            'age_min', round(age_minutes)::int, 'last_status', last_status,
            'fails_3h', fails_last_3h
         ) order by (case health_color when 'red' then 0 when 'amber' then 1 else 2 end), age_minutes desc)
         filter (where should_alert), '[]'::jsonb)
     ) from v_scraper_health where enabled)
);
$$;

grant execute on function public.get_operator_health() to authenticated, anon;
