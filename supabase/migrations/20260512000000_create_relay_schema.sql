-- FL Relay Schema
-- Orchestration layer for FundLocators automated outreach.
-- Multi-channel (SMS, RVM, email) progressive disclosure
-- sequences with A/B experimentation built in.
--
-- relay.* = orchestration. public.outreach_queue = send buffer.
-- When a touch fires, relay writes to outreach_queue and links
-- back via outreach_queue.relay_enrollment_id.

create schema if not exists relay;

create table relay.sequences (
  id          text primary key,
  name        text not null,
  description text,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table relay.experiments (
  id          text primary key,
  name        text not null,
  description text,
  active      boolean not null default true,
  start_date  date,
  end_date    date,
  created_at  timestamptz not null default now()
);

create table relay.experiment_variants (
  id               text primary key,
  experiment_id    text not null references relay.experiments(id) on delete cascade,
  name             text not null,
  weight           int  not null default 50 check (weight between 0 and 100),
  message_template text not null,
  notes            text,
  created_at       timestamptz not null default now()
);

create table relay.sequence_steps (
  id               uuid primary key default gen_random_uuid(),
  sequence_id      text not null references relay.sequences(id) on delete cascade,
  step_number      int  not null,
  channel          text not null check (channel in ('sms', 'rvm', 'email')),
  delay_hours      int  not null default 0,
  message_template text,
  rvm_template_id  uuid references public.rvm_templates(id),
  experiment_id    text references relay.experiments(id),
  notes            text,
  created_at       timestamptz not null default now(),
  unique (sequence_id, step_number)
);

create table relay.enrollments (
  id             uuid primary key default gen_random_uuid(),
  sequence_id    text not null references relay.sequences(id),
  deal_id        text references public.deals(id) on delete set null,
  contact_phone  text not null,
  contact_data   jsonb not null default '{}',
  status         text not null default 'active'
                   check (status in ('active','paused','completed','opted_out','undeliverable','manual_hold')),
  current_step   int  not null default 0,
  enrolled_by    uuid references public.profiles(id) on delete set null,
  enrolled_at    timestamptz not null default now(),
  completed_at   timestamptz,
  opted_out_at   timestamptz,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index relay_enrollments_active_idx
  on relay.enrollments (status, current_step)
  where status = 'active';

create table relay.scheduled_touches (
  id                uuid primary key default gen_random_uuid(),
  enrollment_id     uuid not null references relay.enrollments(id) on delete cascade,
  step_number       int  not null,
  channel           text not null check (channel in ('sms', 'rvm', 'email')),
  variant_id        text references relay.experiment_variants(id),
  rendered_body     text,
  scheduled_at      timestamptz not null,
  status            text not null default 'pending'
                      check (status in ('pending','approved','firing','sent','cancelled','skipped','failed')),
  outreach_queue_id uuid references public.outreach_queue(id) on delete set null,
  sent_at           timestamptz,
  error_message     text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index relay_scheduled_touches_due_idx
  on relay.scheduled_touches (scheduled_at, status)
  where status in ('pending', 'approved');

create table relay.responses (
  id             uuid primary key default gen_random_uuid(),
  enrollment_id  uuid not null references relay.enrollments(id) on delete cascade,
  from_number    text not null,
  body           text not null,
  received_at    timestamptz not null default now(),
  classification text check (classification in ('yes','no','stop','question','hostile','other')),
  classified_at  timestamptz,
  created_at     timestamptz not null default now()
);

alter table public.outreach_queue
  add column if not exists relay_enrollment_id uuid references relay.enrollments(id) on delete set null,
  add column if not exists relay_step_number int;

create or replace function relay.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger trg_sequences_updated_at
  before update on relay.sequences
  for each row execute function relay.set_updated_at();

create trigger trg_enrollments_updated_at
  before update on relay.enrollments
  for each row execute function relay.set_updated_at();

create trigger trg_scheduled_touches_updated_at
  before update on relay.scheduled_touches
  for each row execute function relay.set_updated_at();

alter table relay.sequences           enable row level security;
alter table relay.sequence_steps      enable row level security;
alter table relay.experiments         enable row level security;
alter table relay.experiment_variants enable row level security;
alter table relay.enrollments         enable row level security;
alter table relay.scheduled_touches   enable row level security;
alter table relay.responses           enable row level security;

create policy auth_all on relay.sequences           for all to authenticated using (true) with check (true);
create policy auth_all on relay.sequence_steps      for all to authenticated using (true) with check (true);
create policy auth_all on relay.experiments         for all to authenticated using (true) with check (true);
create policy auth_all on relay.experiment_variants for all to authenticated using (true) with check (true);
create policy auth_all on relay.enrollments         for all to authenticated using (true) with check (true);
create policy auth_all on relay.scheduled_touches   for all to authenticated using (true) with check (true);
create policy auth_all on relay.responses           for all to authenticated using (true) with check (true);
