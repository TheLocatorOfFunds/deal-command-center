-- Usage audit trail: navigation, searches, deal-opens per user. Answers
-- "what did X do in the DCC today" for READS, which the activity table
-- never sees. Insert-only from clients (no update/delete policies), so
-- the trail is immutable from the app.
create table public.user_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null check (event_type in ('app_open','view','search','deal_open')),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index user_events_user_time on public.user_events (user_id, created_at desc);
alter table public.user_events enable row level security;
create policy user_events_insert_own on public.user_events
  for insert to authenticated with check (user_id = auth.uid());
create policy user_events_admin_read on public.user_events
  for select to authenticated using (public.is_admin());
