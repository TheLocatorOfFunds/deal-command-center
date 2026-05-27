-- ─────────────────────────────────────────────────────────────────────
-- 20260527172322_payroll_reminder
--
-- Recurring payroll reminder: fires twice daily (9am + 4pm ET) when any
-- VA has unpaid hours in a completed pay period. Auto-silences once the
-- "Mark Paid" button has been clicked for everyone. Channels handled by
-- the send-payroll-reminder edge function (Resend email + Twilio SMS).
--
-- NOTE: this is the original cut. Two follow-up migrations refine
-- payroll_due_summary():
--   20260527172410_payroll_reminder_fix_date_cast  — fixes a timestamp+int
--     cast error in the Period-B start-date arithmetic
--   20260527172510_payroll_reminder_min_hours_floor — adds a 0.25h floor
--     so accidental same-minute clock in/out don't surface
-- Replaying all three in order lands at the correct final state.
-- ─────────────────────────────────────────────────────────────────────

create extension if not exists pg_net with schema extensions;

-- Shared secret (idempotent)
do $$
declare existing_secret uuid;
begin
  select id into existing_secret from vault.secrets where name = 'payroll_reminder_secret' limit 1;
  if existing_secret is null then
    perform vault.create_secret(encode(gen_random_bytes(32), 'hex'), 'payroll_reminder_secret');
  end if;
end $$;

-- payroll_due_summary(): JSON of outstanding payroll per completed period
create or replace function public.payroll_due_summary()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_today    date := (now() at time zone 'America/New_York')::date;
  v_periods  jsonb := '[]'::jsonb;
  v_grand    numeric := 0;
  v_period   record;
  v_people   jsonb;
  v_total    numeric;
begin
  for v_period in
    with end_days as (
      select d::date as end_date
      from generate_series(v_today - interval '60 days', v_today, '1 day'::interval) d
      where extract(day from d::date) in (10, 25)
    ),
    periods as (
      select
        end_date,
        case
          when extract(day from end_date) = 25
            then date_trunc('month', end_date)::date + 10
          else  date_trunc('month', end_date)::date - interval '1 month' + 25
        end::date as start_date,
        case
          when extract(day from end_date) = 25
            then (date_trunc('month', end_date) + interval '1 month')::date
          else  date_trunc('month', end_date)::date + 14
        end::date as pay_date
      from end_days
    )
    select start_date, end_date, pay_date,
           greatest(0, v_today - pay_date) as days_overdue
    from periods
    where pay_date <= v_today
    order by end_date desc
  loop
    with period_entries as (
      select
        p.id as user_id, p.name,
        sum(extract(epoch from (te.end_at - te.start_at)) / 3600.0) as hours
      from profiles p
      join time_entries te on te.user_id = p.id
      where te.end_at is not null
        and te.start_at::date between v_period.start_date and v_period.end_date
      group by p.id, p.name
      having sum(extract(epoch from (te.end_at - te.start_at)) / 3600.0) > 0
    ),
    applicable_rates as (
      select distinct on (user_id) user_id, rate
      from hourly_rates
      where effective_from <= v_period.end_date
        and (effective_to is null or effective_to >= v_period.end_date)
      order by user_id, effective_from desc
    ),
    unpaid as (
      select
        pe.user_id, pe.name, pe.hours, ar.rate,
        round((pe.hours * coalesce(ar.rate, 0))::numeric, 2) as amount
      from period_entries pe
      left join applicable_rates ar on ar.user_id = pe.user_id
      where not exists (
        select 1 from payments pm
        where pm.user_id = pe.user_id
          and pm.period_start = v_period.start_date
          and pm.period_end   = v_period.end_date
      )
    )
    select
      coalesce(jsonb_agg(jsonb_build_object(
        'user_id', user_id::text, 'name', name,
        'hours', round(hours::numeric, 2), 'rate', rate, 'amount', amount
      ) order by name), '[]'::jsonb),
      coalesce(sum(amount), 0)
    into v_people, v_total
    from unpaid;

    if jsonb_array_length(v_people) > 0 then
      v_grand   := v_grand + v_total;
      v_periods := v_periods || jsonb_build_array(jsonb_build_object(
        'period_start', v_period.start_date,
        'period_end',   v_period.end_date,
        'pay_date',     v_period.pay_date,
        'days_overdue', v_period.days_overdue,
        'period_total', v_total,
        'people',       v_people
      ));
    end if;
  end loop;

  return jsonb_build_object(
    'is_due',      jsonb_array_length(v_periods) > 0,
    'as_of_date',  v_today,
    'grand_total', v_grand,
    'periods',     v_periods
  );
end;
$$;

comment on function public.payroll_due_summary() is
  'JSON snapshot of outstanding payroll: completed periods with unpaid VAs, hours x rate per person. Used by send_payroll_reminder() + send-payroll-reminder edge fn.';

-- verify_payroll_reminder_secret(): boolean compare against vault, never returns the value
create or replace function public.verify_payroll_reminder_secret(p_secret text)
returns boolean
language sql
security definer
set search_path = public, pg_catalog
as $$
  select exists (
    select 1 from vault.decrypted_secrets
    where name = 'payroll_reminder_secret' and decrypted_secret = p_secret
  );
$$;

comment on function public.verify_payroll_reminder_secret(text) is
  'Boolean compare of a candidate secret against vault.payroll_reminder_secret. Never returns the secret. Called by the send-payroll-reminder edge fn for auth.';

revoke all on function public.verify_payroll_reminder_secret(text) from public, anon, authenticated;
grant execute on function public.verify_payroll_reminder_secret(text) to service_role;

-- send_payroll_reminder(): pg_cron entry point, DST-safe hour filter + due pre-check
create or replace function public.send_payroll_reminder()
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_local_hour int := extract(hour from (now() at time zone 'America/New_York'));
  v_secret     text;
begin
  if v_local_hour not in (9, 16) then
    return;
  end if;

  if not coalesce((public.payroll_due_summary()->>'is_due')::boolean, false) then
    return;
  end if;

  select decrypted_secret into v_secret
  from vault.decrypted_secrets where name = 'payroll_reminder_secret' limit 1;

  perform net.http_post(
    url := 'https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/send-payroll-reminder',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Payroll-Reminder-Secret', v_secret
    ),
    body := '{}'::jsonb
  );
end;
$$;

comment on function public.send_payroll_reminder() is
  'pg_cron entry point fired 4x daily (UTC 13/14/20/21). Self-filters to 9am or 4pm ET. If payroll outstanding, pings the send-payroll-reminder edge fn.';

-- pg_cron schedule (re-runnable)
do $$
begin
  perform cron.unschedule('payroll-reminder-twice-daily');
exception when others then null;
end $$;

select cron.schedule(
  'payroll-reminder-twice-daily',
  '0 13,14,20,21 * * *',
  $cron$ select public.send_payroll_reminder() $cron$
);
