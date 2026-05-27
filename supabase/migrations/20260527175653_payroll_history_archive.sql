-- ─────────────────────────────────────────────────────────────────────
-- 20260527175653_payroll_history_archive
--
-- Read-only historical archive of Justin's pre-DCC payroll spreadsheet
-- ("Payroll Tracker.xlsx", Sept 2025 → May 2026). Imported for reference
-- so we can answer year-end questions ("how much did we pay Trevor in
-- 2025", "Eric's rate progression") without keeping the spreadsheet.
--
-- NOT part of the live payroll flow — this is frozen historical data.
-- Going forward, only Eric + Inaam are tracked live (see the payroll
-- enhancements migration). The other 9 contractors live only here.
--
-- Hours were stored in Excel as HH:MM durations; converted to decimal
-- hours on import. The `pay` column is the actual amount paid (it bakes
-- in bonuses/reimbursements — see notes), so pay != rate*hours in places.
-- ─────────────────────────────────────────────────────────────────────

create table if not exists public.payroll_history (
  id          uuid primary key default gen_random_uuid(),
  pay_date    date,
  pay_range   text,
  person_name text not null,
  rate        numeric(8,2),
  hours       numeric(8,2),
  pay         numeric(10,2),
  notes       text,
  status      text,          -- the spreadsheet "Key" column (e.g. 'Paid')
  source      text not null default 'Payroll Tracker.xlsx (imported 2026-05-27)',
  created_at  timestamptz not null default now()
);

create index if not exists payroll_history_name_idx on public.payroll_history(person_name);
create index if not exists payroll_history_paydate_idx on public.payroll_history(pay_date);

comment on table public.payroll_history is
  'Frozen archive of the pre-DCC payroll spreadsheet (Sept 2025 - May 2026). Read-only reference for year-end reporting. Live payroll going forward is Eric + Inaam only via the time-tracking + payroll tables.';

create table if not exists public.payroll_history_roster (
  id        uuid primary key default gen_random_uuid(),
  name      text not null,
  rate_label text,           -- kept as text: some are '?', some numeric
  capacity  text,
  role      text,
  notes     text,
  source    text not null default 'Payroll Tracker.xlsx (imported 2026-05-27)',
  created_at timestamptz not null default now()
);

comment on table public.payroll_history_roster is
  'Contractor roster from the archived payroll spreadsheet. Reference only.';

-- RLS: admin-only read (financial data). No write policies — load is via migration.
alter table public.payroll_history enable row level security;
alter table public.payroll_history_roster enable row level security;

drop policy if exists payroll_history_admin_read on public.payroll_history;
create policy payroll_history_admin_read on public.payroll_history
  for select using (public.is_admin());

drop policy if exists payroll_history_roster_admin_read on public.payroll_history_roster;
create policy payroll_history_roster_admin_read on public.payroll_history_roster
  for select using (public.is_admin());

-- Idempotent load: clear any prior import, then insert.
delete from public.payroll_history;
delete from public.payroll_history_roster;

insert into public.payroll_history (pay_date, pay_range, person_name, rate, hours, pay, notes, status) values
  ('2025-10-01', '9/11/25 - 9/25/25', 'Cy', 6.0, 34.9, 209.47, null, 'Paid'),
  ('2025-10-01', '9/11/25 - 9/25/25', 'Von', 4.0, 59.52, 238.07, null, null),
  ('2025-10-01', '9/11/25 - 9/25/25', 'Eric', 4.0, 64.0, 256.0, null, null),
  ('2025-10-01', '9/11/25 - 9/25/25', 'Khenidy', 4.0, 2.0, 8.0, null, null),
  ('2025-10-01', '9/11/25 - 9/25/25', 'Muriel', 15.0, 10.8, 167.31, '$5.31 for pens', null),
  ('2025-10-01', '9/11/25 - 9/25/25', 'Trevor', 35.0, 14.0, 490.0, null, null),
  ('2025-10-15', '9/26/25 - 10/10/25', 'Cy', 6.0, 30.33, 181.98, null, null),
  ('2025-10-15', '9/26/25 - 10/10/25', 'Von', 4.0, 68.6, 274.4, null, null),
  ('2025-10-15', '9/26/25 - 10/10/25', 'Eric', 4.0, 88.47, 353.87, null, null),
  ('2025-10-15', '9/26/25 - 10/10/25', 'Khenidy', 4.0, 2.0, 0.0, null, null),
  ('2025-10-15', '9/26/25 - 10/10/25', 'Muriel', 15.0, 5.1, 76.5, null, null),
  ('2025-10-15', '9/26/25 - 10/10/25', 'Trevor', 35.0, 23.0, 805.0, null, null),
  ('2025-10-31', '10/11/25 - 10/26/25', 'Cy', 6.0, 36.56, 218.28, null, null),
  ('2025-10-31', '10/11/25 - 10/26/25', 'Von', 4.0, 67.77, 271.07, null, null),
  ('2025-10-31', '10/11/25 - 10/26/25', 'Eric', 4.0, 80.0, 320.0, null, null),
  ('2025-10-31', '10/11/25 - 10/26/25', 'Khenidy', 4.0, 1.5, 6.0, 'Remitly has a $10 min. Add this to next Payroll', null),
  ('2025-10-31', '10/11/25 - 10/26/25', 'Muriel', 15.0, 8.8, 132.0, null, null),
  ('2025-10-31', '10/11/25 - 10/26/25', 'Trevor', 35.0, 19.0, 665.0, null, null),
  ('2025-11-17', '10/27/25 - 11/10/25', 'Cy', 6.0, null, 218.28, null, null),
  ('2025-11-17', '10/27/25 - 11/10/25', 'Von', 4.0, 68.63, 274.53, null, null),
  ('2025-11-17', '10/27/25 - 11/10/25', 'Eric', 4.0, 88.0, 352.0, null, null),
  ('2025-11-17', '10/27/25 - 11/10/25', 'Khenidy', 4.0, 22.0, 88.0, 'caught up pay from last month', null),
  ('2025-11-17', '10/27/25 - 11/10/25', 'Muriel', 15.0, 5.33, 80.0, null, null),
  ('2025-11-17', '10/27/25 - 11/10/25', 'Trevor', 35.0, 28.0, 980.0, null, null),
  ('2025-12-01', '11/11/25 - 11/25/25', 'Cy', 6.0, 20.33, 121.98, null, null),
  ('2025-12-01', '11/11/25 - 11/25/25', 'Von', 4.0, 52.13, 208.52, null, null),
  ('2025-12-01', '11/11/25 - 11/25/25', 'Eric', 4.0, 88.0, 352.0, null, null),
  ('2025-12-01', '11/11/25 - 11/25/25', 'Khenidy', 4.0, 6.5, 26.0, null, null),
  ('2025-12-01', '11/11/25 - 11/25/25', 'Muriel', 15.0, 6.47, 97.0, null, null),
  ('2025-12-01', '11/11/25 - 11/25/25', 'Trevor', 35.0, 27.0, 945.0, null, null),
  ('2025-12-15', '11/26/25 - 12/10/25', 'Cy', 6.0, 27.51, 165.06, null, null),
  ('2025-12-15', '11/26/25 - 12/10/25', 'Von', 4.0, 67.45, 268.9, 'Sent an early pay on 12/11/25', null),
  ('2025-12-15', '11/26/25 - 12/10/25', 'Eric', 4.0, 36.0, 144.0, null, null),
  ('2025-12-15', '11/26/25 - 12/10/25', 'Khenidy', 4.0, null, null, null, null),
  ('2025-12-15', '11/26/25 - 12/10/25', 'Muriel', 15.0, 4.03, 60.5, null, null),
  ('2025-12-15', '11/26/25 - 12/10/25', 'Trevor', 35.0, 18.0, 630.0, null, null),
  ('2025-12-15', '11/26/25 - 12/10/25', 'Mason', null, 2.0, 150.0, null, null),
  ('2026-01-01', '12/11/25 - 12/25/25', 'Cy', 6.0, 28.91, 173.46, 'Paid on 12/29/25 for 12/11/25 - 12/26/25', null),
  ('2026-01-01', '12/11/25 - 12/25/25', 'Von', 4.0, 37.08, 148.33, null, null),
  ('2026-01-01', '12/11/25 - 12/25/25', 'Eric', 4.0, 80.0, 320.0, null, null),
  ('2026-01-01', '12/11/25 - 12/25/25', 'Khenidy', 4.0, 0.0, 0.0, null, null),
  ('2026-01-01', '12/11/25 - 12/25/25', 'Muriel', 15.0, 0.0, 0.0, null, null),
  ('2026-01-01', '12/11/25 - 12/25/25', 'Trevor', 35.0, 38.0, 1330.0, null, null),
  ('2026-01-01', '12/11/25 - 12/25/25', 'Mason', null, 0.0, 0.0, null, null),
  ('2026-01-15', '12/26/25 - 1/10/26', 'Inaam', 4.0, 48.0, 192.0, null, null),
  ('2026-01-15', '12/26/25 - 1/10/26', 'Von', 4.0, 57.53, 230.13, null, null),
  ('2026-01-15', '12/26/25 - 1/10/26', 'Eric', 5.0, 75.0, 375.0, null, null),
  ('2026-01-15', '12/26/25 - 1/10/26', 'Khenidy', 4.0, 0.0, null, null, null),
  ('2026-01-15', '12/26/25 - 1/10/26', 'Muriel', 15.0, 0.0, null, null, null),
  ('2026-01-15', '12/26/25 - 1/10/26', 'Trevor', 35.0, 25.0, 875.0, null, null),
  ('2026-01-15', '12/26/25 - 1/10/26', 'Mason', null, null, null, null, null),
  ('2026-02-02', '1/11/25 - 1/25/26', 'Inaam', 4.0, 80.0, 320.0, null, null),
  ('2026-02-02', '1/11/25 - 1/25/26', 'Von', 4.0, 63.27, 253.07, null, null),
  ('2026-02-02', '1/11/25 - 1/25/26', 'Eric', 5.0, 80.0, 400.0, null, null),
  ('2026-02-02', '1/11/25 - 1/25/26', 'Khenidy', 4.0, 0.0, null, null, null),
  ('2026-02-02', '1/11/25 - 1/25/26', 'Muriel', 15.0, 0.0, null, null, null),
  ('2026-02-02', '1/11/25 - 1/25/26', 'Trevor', 35.0, 38.5, 1347.5, null, null),
  ('2026-02-02', '1/11/25 - 1/25/26', 'Mason', null, null, null, null, null),
  ('2026-02-16', '1/26/26 - 2/10/26', 'Inaam', 4.0, 96.0, 384.0, null, null),
  ('2026-02-16', '1/26/26 - 2/10/26', 'Von', 4.0, 81.62, 326.47, null, null),
  ('2026-02-16', '1/26/26 - 2/10/26', 'Eric', 5.0, 92.0, 460.0, null, null),
  ('2026-02-16', '1/26/26 - 2/10/26', 'Khenidy', 4.0, 0.0, null, null, null),
  ('2026-02-16', '1/26/26 - 2/10/26', 'Muriel', 15.0, 0.0, null, null, null),
  ('2026-02-16', '1/26/26 - 2/10/26', 'Trevor', 35.0, 3.5, 122.5, null, null),
  ('2026-02-16', '1/26/26 - 2/10/26', 'Mason', null, null, 300.0, '2026-02-06T00:00:00', null),
  ('2026-03-03', '2/11/26 - 2/25/26', 'Inaam', 4.0, 88.0, 352.0, null, null),
  ('2026-03-03', '2/11/26 - 2/25/26', 'Von', 4.0, 62.7, 250.8, null, null),
  ('2026-03-03', '2/11/26 - 2/25/26', 'Eric', 5.0, 88.0, 440.0, null, null),
  ('2026-03-18', '2/26/26 - 3/10/26', 'Inaam', 4.0, 72.0, 288.0, null, null),
  ('2026-03-18', '2/26/26 - 3/10/26', 'Von', 4.0, 64.7, 258.8, null, null),
  ('2026-03-18', '2/26/26 - 3/10/26', 'Eric', 5.0, 72.0, 360.0, null, null),
  ('2026-04-01', '3/11/26 - 3/25/26', 'Inaam', 4.0, 80.0, 320.0, null, null),
  ('2026-04-01', '3/11/26 - 3/25/26', 'Von', 4.0, 65.88, 263.53, null, null),
  ('2026-04-01', '3/11/26 - 3/25/26', 'Eric', 5.0, 80.0, 400.0, null, null),
  ('2026-04-15', '3/26/26 - 4/10/26', 'Inaam', 4.0, 88.0, 402.0, '$352 + 50 Kemper Ansel Bonus = $402', null),
  ('2026-04-15', '3/26/26 - 4/10/26', 'Von', 4.0, 58.6, 234.4, 'Von was let go 4/13/26', null),
  ('2026-04-15', '3/26/26 - 4/10/26', 'Eric', 5.0, 88.0, 490.0, '$440 + $50 Kemper Ansel Bonus = $490', null),
  ('2026-05-01', '4/11/26 - 4/25/26', 'Inaam', 4.0, 80.0, 320.0, null, null),
  ('2026-05-01', '4/11/26 - 4/25/26', 'Eric', 5.0, 78.0, 390.0, null, null),
  ('2026-05-20', '4/11/26 - 5/25/26', 'Inaam', 4.0, 80.0, 320.0, null, null),
  ('2026-05-20', '4/11/26 - 5/25/26', 'Eric', 5.0, 80.0, 400.0, null, null);

insert into public.payroll_history_roster (name, rate_label, capacity, role, notes) values
  ('Trevor Chase', '35.0', '40-80 a month', 'Developer', null),
  ('Muriel Marcum', '15.0', ' 10 hrs a week', 'Direct Mailer', 'Pay: 1st and 15th 
Pay Period: 11-25 and 26-10'),
  ('Robbie McClelland', '20.0', 'Summer', 'Videographer', null),
  ('Anna Eichelberger', '20.0', 'TBD', 'Graphic Designer, Social Media', null),
  ('Robyn Urig', '65.0', '2-8 a month', 'Bookkeeping', null),
  ('Mic Tienken', '?', 'Contract', 'Web Developer, SEO', null),
  ('Cyril Sapungan', '6.0', '15 a week', 'VA Caller', 'Pay: 1st and 15th 
Pay Period: 11-25 and 26-10'),
  ('Von Erika', '4.0', '40 a week', 'VA Admin', 'Pay: 1st and 15th 
Pay Period: 11-25 and 26-10'),
  ('Khendiy Bari', '4.0', 'As Needed', null, 'Pay: 1st and 15th 
Pay Period: 11-25 and 26-10'),
  ('Eric Vaugh', '4.0', '40 a week', 'Surplus Funds', 'Pay: 1st and 15th 
Pay Period: 11-25 and 26-10'),
  ('Cristian Diaz', '35.0', null, 'GHL, Automations, Chat Agent', null);
