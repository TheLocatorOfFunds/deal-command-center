-- Appointments — Eric sets a real meeting time with a lead during/after a call
-- (Nathan 2026-06-29). Distinct from follow-ups (date-only reminders): an
-- appointment is a confirmed meeting at a specific time, with a type
-- (in-person / phone call-back / video) and optional location/note.
-- Surfaced in a dedicated Appointments agenda + on the lead.
create table if not exists public.appointments (
  id uuid primary key default gen_random_uuid(),
  deal_id text references public.deals(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  scheduled_at timestamptz not null,
  kind text not null default 'in_person',     -- in_person | phone | video
  location text,
  note text,
  status text not null default 'scheduled',    -- scheduled | completed | no_show | cancelled
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_appointments_scheduled_at on public.appointments(scheduled_at);
create index if not exists idx_appointments_deal_id on public.appointments(deal_id);

alter table public.appointments enable row level security;
grant select, insert, update, delete on public.appointments to authenticated;

create policy admin_all_appointments on public.appointments
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy va_all_appointments on public.appointments
  for all to authenticated using (public.is_va()) with check (public.is_va());
