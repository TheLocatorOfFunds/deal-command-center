-- team_communications
-- Central data pipeline table for all business communications.
-- Written to by gmail-sync (edge function, runs Saturday night).
-- Read by monday-memo, and eventually DCC's Comms Intelligence view.
--
-- Sources: gmail_justin, gmail_nathan, granola_justin, granola_nathan, github
-- Each row = one week's summary from one person/source.

create table if not exists public.team_communications (
  id          uuid primary key default gen_random_uuid(),
  week_of     date not null,          -- Sunday of the week this covers (normalized)
  person      text not null,          -- 'justin', 'nathan', 'team'
  source      text not null,          -- 'gmail', 'granola', 'github'
  summary     text,                   -- Claude-summarized plain text (used in prompts)
  raw_data    jsonb default '[]',     -- full structured data (emails, meetings, etc.)
  created_at  timestamptz default now(),
  updated_at  timestamptz default now(),

  -- one row per week/person/source combo — upsert replaces on re-run
  unique (week_of, person, source)
);

-- index for the monday-memo read pattern
create index if not exists team_communications_week_idx
  on public.team_communications (week_of desc);

-- RLS: same permissive auth policy as all other tables
alter table public.team_communications enable row level security;

create policy auth_all on public.team_communications
  for all to authenticated
  using (true)
  with check (true);

-- updated_at trigger
create or replace function public.set_team_communications_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger team_communications_updated_at
  before update on public.team_communications
  for each row execute function public.set_team_communications_updated_at();

comment on table public.team_communications is
  'Central business intelligence pipeline. Aggregates Gmail + Granola + GitHub summaries per week per person. Powers Monday Memo and eventually DCC Comms Intelligence.';
