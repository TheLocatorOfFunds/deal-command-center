-- Fix: Period B start-date arithmetic produced "timestamp + integer".
-- `date_trunc(...)::date - interval '1 month'` yields a timestamp, so the
-- subsequent "+ 25" failed. Cast to date AFTER the interval subtraction,
-- before adding days. Full function replace (only the one line changed).
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
          else  (date_trunc('month', end_date) - interval '1 month')::date + 25
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
