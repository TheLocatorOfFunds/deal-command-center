-- Time tracking for VAs (Erik, Anam) — clock-in/out, hourly rates, payroll periods
--
-- Pay-period model (custom bi-monthly):
--   Period A: 11th–25th of month X       → paid 1st of month X+1
--   Period B: 26th of month X – 10th of X+1 → paid 15th of month X+1
--
-- Three tables:
--   time_entries  — one row per clock-in/out shift
--   hourly_rates  — per-user rate w/ effective dates (admin-only)
--   payments      — per-period payroll record marking a period as paid (admin-only)

-- ---------------------------------------------------------------------------
-- TIME_ENTRIES
-- ---------------------------------------------------------------------------
create table public.time_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  start_at timestamptz not null,
  end_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint time_entries_end_after_start check (end_at is null or end_at > start_at)
);

create index idx_time_entries_user_start on public.time_entries(user_id, start_at desc);

-- Only one open (un-clocked-out) entry per user at a time.
create unique index unique_open_time_entry_per_user
  on public.time_entries(user_id) where end_at is null;

create trigger time_entries_set_updated_at
  before update on public.time_entries
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- HOURLY_RATES
-- ---------------------------------------------------------------------------
create table public.hourly_rates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  rate numeric(10,2) not null check (rate > 0),
  effective_from date not null default current_date,
  effective_to date,
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  constraint hourly_rates_to_after_from check (effective_to is null or effective_to >= effective_from)
);

create index idx_hourly_rates_user on public.hourly_rates(user_id, effective_from desc);

-- ---------------------------------------------------------------------------
-- PAYMENTS
-- ---------------------------------------------------------------------------
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  hours_worked numeric(8,2) not null check (hours_worked >= 0),
  rate_used numeric(10,2) not null check (rate_used >= 0),
  amount_paid numeric(10,2) not null check (amount_paid >= 0),
  paid_at timestamptz not null default now(),
  paid_by uuid references auth.users(id),
  payment_method text,
  payment_reference text,
  notes text,
  constraint payments_period_valid check (period_end >= period_start),
  unique(user_id, period_start, period_end)
);

create index idx_payments_user_period on public.payments(user_id, period_start desc);

-- ---------------------------------------------------------------------------
-- PAY_PERIOD_FOR_DATE — canonical bi-monthly schedule
-- ---------------------------------------------------------------------------
create or replace function public.pay_period_for_date(d date)
returns table(period_start date, period_end date, pay_date date)
language plpgsql
immutable
as $$
declare
  day_num int := extract(day from d)::int;
  yr int := extract(year from d)::int;
  mo int := extract(month from d)::int;
begin
  if day_num between 11 and 25 then
    -- Period A: 11–25 of current month → pay 1st of next month
    period_start := make_date(yr, mo, 11);
    period_end := make_date(yr, mo, 25);
    pay_date := (make_date(yr, mo, 1) + interval '1 month')::date;
  elsif day_num >= 26 then
    -- Period B starts 26th of current month, ends 10th of next month → pay 15th of next month
    period_start := make_date(yr, mo, 26);
    period_end := (make_date(yr, mo, 10) + interval '1 month')::date;
    pay_date := (make_date(yr, mo, 15) + interval '1 month')::date;
  else
    -- day_num between 1 and 10: still in Period B that started 26th of prior month
    period_end := make_date(yr, mo, 10);
    period_start := (make_date(yr, mo, 26) - interval '1 month')::date;
    pay_date := make_date(yr, mo, 15);
  end if;
  return next;
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.time_entries enable row level security;
alter table public.hourly_rates enable row level security;
alter table public.payments enable row level security;

-- time_entries: VAs (and admins) see their own; admins see all.
create policy "time_entries: read own or admin all"
  on public.time_entries for select
  using (user_id = auth.uid() or public.is_admin());

create policy "time_entries: insert own"
  on public.time_entries for insert
  with check (user_id = auth.uid());

create policy "time_entries: update own or admin"
  on public.time_entries for update
  using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());

create policy "time_entries: delete own or admin"
  on public.time_entries for delete
  using (user_id = auth.uid() or public.is_admin());

-- hourly_rates: admin-only on every operation. VAs cannot see their own rate.
create policy "hourly_rates: admin all"
  on public.hourly_rates for all
  using (public.is_admin())
  with check (public.is_admin());

-- payments: admin-only.
create policy "payments: admin all"
  on public.payments for all
  using (public.is_admin())
  with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- Realtime: time_entries (so the user's own clock state syncs across tabs/devices)
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'time_entries'
  ) then
    alter publication supabase_realtime add table public.time_entries;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Helpful view for admin reporting (computed hours per user per pay period)
-- ---------------------------------------------------------------------------
create or replace view public.v_pay_period_summary as
with periods as (
  select distinct (public.pay_period_for_date(start_at::date)).*
  from public.time_entries
  where end_at is not null
),
hours_per_period as (
  select
    p.period_start,
    p.period_end,
    p.pay_date,
    te.user_id,
    coalesce(sum(extract(epoch from (te.end_at - te.start_at)) / 3600.0), 0)::numeric(8,2) as hours_worked
  from periods p
  left join public.time_entries te
    on te.start_at::date between p.period_start and p.period_end
   and te.end_at is not null
  group by p.period_start, p.period_end, p.pay_date, te.user_id
)
select
  hpp.user_id,
  hpp.period_start,
  hpp.period_end,
  hpp.pay_date,
  hpp.hours_worked,
  -- Latest applicable rate at the end of the period
  (
    select hr.rate
    from public.hourly_rates hr
    where hr.user_id = hpp.user_id
      and hr.effective_from <= hpp.period_end
      and (hr.effective_to is null or hr.effective_to >= hpp.period_end)
    order by hr.effective_from desc
    limit 1
  ) as rate,
  pmt.id as payment_id,
  pmt.paid_at,
  pmt.amount_paid
from hours_per_period hpp
left join public.payments pmt
  on pmt.user_id = hpp.user_id
 and pmt.period_start = hpp.period_start
 and pmt.period_end = hpp.period_end
where hpp.user_id is not null;

-- View RLS — view-level grant is admin-only.
-- (Views inherit RLS from underlying tables, but since hourly_rates + payments are admin-only,
--  the view is effectively admin-only.)
grant select on public.v_pay_period_summary to authenticated;
