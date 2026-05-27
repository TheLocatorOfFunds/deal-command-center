-- ─────────────────────────────────────────────────────────────────────
-- 20260527175900_payroll_enhancements
--
-- Live payroll enhancements for Eric + Inaam (the going-forward simple
-- version — other contractors live only in payroll_history archive):
--   1. payroll_hour_adjustments — admin override of computed hours per
--      (user, period) + a note. Preserves raw time_entries.
--   2. payments.bonus + bonus_note — bonuses entered at Mark-Paid time.
--   3. hourly_rates.note — reason on each rate change.
--   4. payroll_due_summary() — respects adjusted hours so the twice-daily
--      reminder reflects corrections.
-- ─────────────────────────────────────────────────────────────────────

-- 1. Hour adjustments
create table if not exists public.payroll_hour_adjustments (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles(id) on delete cascade,
  period_start   date not null,
  period_end     date not null,
  adjusted_hours numeric(8,2) not null,
  note           text,
  adjusted_by    uuid references public.profiles(id),
  adjusted_at    timestamptz not null default now(),
  unique (user_id, period_start, period_end)
);

comment on table public.payroll_hour_adjustments is
  'Admin override of computed time-entry hours for a (user, pay period). Preserves raw time_entries; display + payroll use COALESCE(adjusted_hours, tracked). Carries a note for bookkeeping (why the hours were corrected).';

alter table public.payroll_hour_adjustments enable row level security;
drop policy if exists payroll_hour_adj_admin_all on public.payroll_hour_adjustments;
create policy payroll_hour_adj_admin_all on public.payroll_hour_adjustments
  for all using (public.is_admin()) with check (public.is_admin());

-- 2. Bonus on payments
alter table public.payments add column if not exists bonus      numeric(10,2) not null default 0;
alter table public.payments add column if not exists bonus_note text;
comment on column public.payments.bonus is 'Bonus added at Mark-Paid time, on top of hours x rate. amount_paid already includes it.';
comment on column public.payments.bonus_note is 'Why the bonus was given (e.g. "Kemper Ansel close bonus").';

-- 3. Note on rate changes
alter table public.hourly_rates add column if not exists note text;
comment on column public.hourly_rates.note is 'Reason for this rate (e.g. "$4 -> $5 performance bump 5/1"). Shows in the rate-history tooltip.';

-- 4. payroll_due_summary() — use adjusted hours when present
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
        sum(extract(epoch from (te.end_at - te.start_at)) / 3600.0) as tracked_hours
      from profiles p
      join time_entries te on te.user_id = p.id
      where te.end_at is not null
        and te.start_at::date between v_period.start_date and v_period.end_date
      group by p.id, p.name
      having sum(extract(epoch from (te.end_at - te.start_at)) / 3600.0) >= 0.25
    ),
    adjusted as (
      select
        pe.user_id, pe.name,
        coalesce(adj.adjusted_hours, round(pe.tracked_hours::numeric, 2)) as hours
      from period_entries pe
      left join payroll_hour_adjustments adj
        on adj.user_id = pe.user_id
       and adj.period_start = v_period.start_date
       and adj.period_end   = v_period.end_date
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
        a.user_id, a.name, a.hours, ar.rate,
        round((a.hours * coalesce(ar.rate, 0))::numeric, 2) as amount
      from adjusted a
      left join applicable_rates ar on ar.user_id = a.user_id
      where not exists (
        select 1 from payments pm
        where pm.user_id = a.user_id
          and pm.period_start = v_period.start_date
          and pm.period_end   = v_period.end_date
      )
    )
    select
      coalesce(jsonb_agg(jsonb_build_object(
        'user_id', user_id::text, 'name', name,
        'hours', hours, 'rate', rate, 'amount', amount
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
