-- Team messaging v2 — owner delete + EOD reports + screen recording scaffold.
--
-- Per Nathan 2026-04-29:
--   "How can we take messaging to the next level? I want to be able to as
--   the owner, delete threads. We use Google Chat for everything because
--   Eric and Inaam use Google Meet all day. I want all our team comms to
--   live in here. Eric and Inaam leave an update every day of what they
--   have done in Google Meet — I want them to do that from here. And if
--   the video watched their screen all day, it would not know what they
--   did."
--
-- This migration adds the schema for:
--   B. eod_reports — daily standup-style EOD reports per teammate
--   E. screen_recordings — scaffold for the "watch + summarize" feature.
--      No AI summarization yet (free tier — that comes later when Nathan
--      wants to spend on Claude API tokens). Just the table + storage
--      bucket so the recording feature has a place to land.
--
-- A (owner-delete-threads) is enforced client-side via OWNER_EMAILS for
-- now. The DB-level guard 20260429130000 already covers role changes;
-- thread deletes are rare-enough + reversible enough that we trust the
-- client gate. If we add multi-team support later, a is_owner() RLS
-- policy on team_threads UPDATE/DELETE would be the next step.
--
-- D (Jitsi video) doesn't need any schema — it's pure client-side link
-- generation that pops out https://meet.jit.si/<room>.

-- ── B. EOD reports ──────────────────────────────────────────────────
create table if not exists public.eod_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  report_date date not null,
  worked_on text,
  blocked text,
  next_up text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One report per person per day. Re-submitting the same day overwrites.
  unique (user_id, report_date)
);

create index if not exists idx_eod_reports_date on public.eod_reports(report_date desc);
create index if not exists idx_eod_reports_user_date on public.eod_reports(user_id, report_date desc);

alter table public.eod_reports enable row level security;

-- Anyone on the team can read all EOD reports (it's a daily standup —
-- visibility IS the point). Only the author can write their own.
drop policy if exists "team can read all eod reports" on public.eod_reports;
create policy "team can read all eod reports"
  on public.eod_reports for select
  using (public.is_admin() OR public.is_va());

drop policy if exists "users can write their own eod reports" on public.eod_reports;
create policy "users can write their own eod reports"
  on public.eod_reports for insert
  with check (auth.uid() = user_id);

drop policy if exists "users can update their own eod reports" on public.eod_reports;
create policy "users can update their own eod reports"
  on public.eod_reports for update
  using (auth.uid() = user_id);

-- updated_at auto-bump on update
create or replace function public.tg_eod_reports_updated_at()
returns trigger language plpgsql as $$
begin NEW.updated_at = now(); return NEW; end;
$$;
drop trigger if exists tg_eod_reports_updated_at on public.eod_reports;
create trigger tg_eod_reports_updated_at
  before update on public.eod_reports
  for each row execute function public.tg_eod_reports_updated_at();

comment on table public.eod_reports is
  'End-of-day standup reports per teammate. Replaces the Google Meet ritual where Eric/Inaam walk through what they did each day.';

-- ── E. Screen recordings (scaffold only — no AI yet) ─────────────────
create table if not exists public.screen_recordings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  storage_path text,            -- path in screen-recordings bucket
  duration_seconds integer,
  size_bytes bigint,
  ai_summary text,              -- nullable; populated later when AI runs
  ai_summary_status text default 'pending',  -- pending | running | done | failed
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_screen_recordings_user
  on public.screen_recordings(user_id, started_at desc);

alter table public.screen_recordings enable row level security;

-- Owners read all. Users read their own. Users insert their own.
drop policy if exists "owners read all screen recordings" on public.screen_recordings;
create policy "owners read all screen recordings"
  on public.screen_recordings for select
  using (public.is_owner());

drop policy if exists "users read their own screen recordings" on public.screen_recordings;
create policy "users read their own screen recordings"
  on public.screen_recordings for select
  using (auth.uid() = user_id);

drop policy if exists "users insert their own screen recordings" on public.screen_recordings;
create policy "users insert their own screen recordings"
  on public.screen_recordings for insert
  with check (auth.uid() = user_id);

drop policy if exists "users update their own screen recordings" on public.screen_recordings;
create policy "users update their own screen recordings"
  on public.screen_recordings for update
  using (auth.uid() = user_id);

comment on table public.screen_recordings is
  'Per-teammate screen recordings. v1 stores the file + metadata. v2 (paid) will run a Claude Vision summarizer over each recording and populate ai_summary.';

-- Storage bucket — private, owner+self read.
insert into storage.buckets (id, name, public)
values ('screen-recordings', 'screen-recordings', false)
on conflict (id) do nothing;

-- Storage policies: users can upload to their own folder; owners can read all.
drop policy if exists "users upload screen recordings" on storage.objects;
create policy "users upload screen recordings"
  on storage.objects for insert
  with check (
    bucket_id = 'screen-recordings'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "users read own screen recordings" on storage.objects;
create policy "users read own screen recordings"
  on storage.objects for select
  using (
    bucket_id = 'screen-recordings'
    and (
      auth.uid()::text = (storage.foldername(name))[1]
      or public.is_owner()
    )
  );
