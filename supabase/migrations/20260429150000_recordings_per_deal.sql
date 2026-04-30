-- Per-deal screen recordings — Loom replacement.
--
-- Per Nathan 2026-04-29: Inaam currently makes a Loom for every case he
-- processes. Their Looms sit on Loom's servers + Loom does the AI summary.
-- We're moving that workflow into DCC: record from the deal Files tab,
-- store in Supabase, transcribe via the browser's free Web Speech API
-- while recording, summarize with Claude. Per-deal so each case has its
-- own video log.
--
-- Builds on the screen_recordings scaffold from 20260429140000_team_messaging_v2.

alter table public.screen_recordings
  add column if not exists title text,
  add column if not exists deal_id text references public.deals(id) on delete set null,
  add column if not exists transcript text;

create index if not exists idx_screen_recordings_deal
  on public.screen_recordings(deal_id, started_at desc)
  where deal_id is not null;

comment on column public.screen_recordings.title is
  'Human-readable title — set when user clicks Save after stopping the recording.';
comment on column public.screen_recordings.deal_id is
  'Optional FK to deals. When set, the recording shows up on the deal Files tab. Null for unscoped recordings.';
comment on column public.screen_recordings.transcript is
  'Raw speech-to-text from the browser Web Speech API, captured concurrently with the video. Source for ai_summary.';

-- Allow team to read recordings linked to deals they can see (admin/va read all).
-- The existing "owners read all" + "users read their own" policies stay in place.
drop policy if exists "team can read deal-linked recordings" on public.screen_recordings;
create policy "team can read deal-linked recordings"
  on public.screen_recordings for select
  using (
    deal_id is not null and (public.is_admin() or public.is_va())
  );
