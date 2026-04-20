-- Phase 0: Outbound SMS messages table
-- Run in Supabase SQL editor or via: supabase db push

create table if not exists public.messages_outbound (
  id            uuid        primary key default gen_random_uuid(),
  deal_id       text        references public.deals(id) on delete set null,
  to_number     text        not null,
  from_number   text,
  body          text        not null,
  status        text        not null default 'queued',
  twilio_sid    text,
  error_code    text,
  error_message text,
  sent_by       uuid        references auth.users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.messages_outbound enable row level security;

-- INSERT: admin, user (legacy), and va roles only
create policy "sms_outbound_insert" on public.messages_outbound
  for insert to authenticated
  with check (
    (select role from public.profiles where id = auth.uid()) in ('admin', 'user', 'va')
  );

-- SELECT: every authenticated user can see their own rows
create policy "sms_outbound_select_own" on public.messages_outbound
  for select to authenticated
  using (sent_by = auth.uid());

-- SELECT: admins can see all rows
create policy "sms_outbound_select_admin" on public.messages_outbound
  for select to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) = 'admin'
  );

-- updated_at trigger (create or replace so it's safe to run twice)
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger messages_outbound_updated_at
  before update on public.messages_outbound
  for each row execute function public.set_updated_at();

-- Indexes
create index if not exists messages_outbound_created_at_idx on public.messages_outbound (created_at desc);
create index if not exists messages_outbound_sent_by_idx    on public.messages_outbound (sent_by);
create index if not exists messages_outbound_deal_id_idx    on public.messages_outbound (deal_id);
create index if not exists messages_outbound_to_number_idx  on public.messages_outbound (to_number);
