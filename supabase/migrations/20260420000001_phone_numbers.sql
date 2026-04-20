-- Phone numbers available for outbound SMS
-- Populate this table after Twilio setup via Supabase SQL editor or dashboard

create table if not exists public.phone_numbers (
  id          uuid        primary key default gen_random_uuid(),
  label       text        not null,
  number      text        not null unique,
  active      boolean     not null default true,
  created_at  timestamptz not null default now()
);

alter table public.phone_numbers enable row level security;

-- All authenticated users can read available numbers
create policy "phone_numbers_select" on public.phone_numbers
  for select to authenticated using (true);

-- Only admins can insert/update/delete
create policy "phone_numbers_admin_write" on public.phone_numbers
  for all to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) = 'admin'
  )
  with check (
    (select role from public.profiles where id = auth.uid()) = 'admin'
  );

-- Seed your Twilio trial number here (edit to match yours after setup)
-- insert into public.phone_numbers (label, number) values ('Trial Number', '+14155550100');
