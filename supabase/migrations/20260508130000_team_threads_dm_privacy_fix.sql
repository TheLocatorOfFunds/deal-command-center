-- Privacy fix: VA was seeing the Nathan↔Justin DM thread.
--
-- Reported by Eric 2026-05-08: "in threads, I can see everybody's chat,
-- even the one between you and JJ — you might wanna fix that."
--
-- Root cause: Phase 3 (20260427030000_team_chat_phase3.sql) introduced
-- the thread_type column with `default 'channel'` and added RLS that
-- gated `thread_type='dm'` threads to participants. Two failure modes:
--   1. DMs created BEFORE Phase 3 defaulted to 'channel' (column-add
--      default applied to existing rows). Phase 3 RLS lets all
--      admin/va read 'channel' → those legacy DMs leaked.
--   2. Even post-Phase 3, threads created via direct insert (instead
--      of the team_create_dm RPC) don't get thread_type='dm' set.
--
-- Fix replaces the thread_type-based gate with a stronger invariant:
--   "If a thread has any team_thread_participants rows, ONLY those
--    participants can read it. If it has none, it's open to admin/va."
-- That makes thread_type cosmetic for access purposes — the actual
-- gate is participants, which is harder to misconfigure.
--
-- Backfill participants from message senders ONLY for threads with the
-- canonical DM title pattern (' <-> ', emitted by team_create_dm). Other
-- 2-person threads are NOT auto-locked-down; admin can manually run
-- the SELECT at the bottom of this file to find candidates and decide.

-- ── Step 1: backfill participants for canonical-DM-titled threads ──
-- (' <-> ' is what team_create_dm emits, e.g. "Nathan <-> Justin")
with dm_threads_no_participants as (
  select id from public.team_threads
  where title like '% <-> %'
    and not exists (
      select 1 from public.team_thread_participants tp
      where tp.thread_id = team_threads.id
    )
)
insert into public.team_thread_participants (thread_id, user_id)
select distinct m.thread_id, m.sender_id
from public.team_messages m
join dm_threads_no_participants dtnp on dtnp.id = m.thread_id
where m.sender_id is not null
on conflict (thread_id, user_id) do nothing;

-- ── Step 2: cosmetic — reclassify ' <-> ' threads to thread_type='dm'
-- so the UI labels them correctly. RLS doesn't depend on this anymore
-- but the UI does (badges, icons, sort order).
update public.team_threads
set thread_type = 'dm'
where title like '% <-> %'
  and thread_type not in ('dm', 'lauren_dm', 'lauren_room');

-- ── Step 3: replace the read policy with the participants-based gate
drop policy if exists team_threads_admin_va on public.team_threads;
create policy team_threads_admin_va on public.team_threads
  for all to authenticated
  using (
    (public.is_admin() or public.is_va())
    and (
      -- Open thread: no participants list, all admin/va can read
      not exists (
        select 1 from public.team_thread_participants tp
        where tp.thread_id = team_threads.id
      )
      -- Or scoped thread: you must be a participant
      or exists (
        select 1 from public.team_thread_participants tp
        where tp.thread_id = team_threads.id and tp.user_id = auth.uid()
      )
    )
  )
  with check (public.is_admin() or public.is_va());

drop policy if exists team_messages_admin_va on public.team_messages;
create policy team_messages_admin_va on public.team_messages
  for all to authenticated
  using (
    (public.is_admin() or public.is_va())
    and exists (
      select 1 from public.team_threads t
      where t.id = team_messages.thread_id
        and (
          not exists (
            select 1 from public.team_thread_participants tp
            where tp.thread_id = t.id
          )
          or exists (
            select 1 from public.team_thread_participants tp
            where tp.thread_id = t.id and tp.user_id = auth.uid()
          )
        )
    )
  )
  with check (public.is_admin() or public.is_va());

-- ── Step 4: same gate for reactions
drop policy if exists team_reactions_admin_va on public.team_reactions;
create policy team_reactions_admin_va on public.team_reactions
  for all to authenticated
  using (
    (public.is_admin() or public.is_va())
    and exists (
      select 1 from public.team_messages m
      join public.team_threads t on t.id = m.thread_id
      where m.id = team_reactions.message_id
        and (
          not exists (
            select 1 from public.team_thread_participants tp
            where tp.thread_id = t.id
          )
          or exists (
            select 1 from public.team_thread_participants tp
            where tp.thread_id = t.id and tp.user_id = auth.uid()
          )
        )
    )
  )
  with check (public.is_admin() or public.is_va());

comment on policy team_threads_admin_va on public.team_threads is
  'Privacy invariant (added 2026-05-08): if a thread has any participants entry, only those participants can read/write. If it has no participants entry, open to all admin/va. Replaces the older thread_type=''dm''-based gate which leaked legacy DMs created before thread_type existed.';

-- ── Audit query (NOT executed — for the operator to inspect after applying)
--
-- Find any other 2-person threads not titled ' <-> ' that might be DMs
-- in disguise. If any of these should be private, manually backfill
-- participants from message senders and they'll inherit the new gate.
--
-- select t.id, t.title, t.thread_type, t.created_at,
--   array_agg(distinct m.sender_id) as distinct_senders
-- from public.team_threads t
-- join public.team_messages m on m.thread_id = t.id and m.sender_id is not null
-- where t.archived_at is null
--   and t.thread_type not in ('dm', 'lauren_dm', 'lauren_room', 'deal')
--   and not exists (select 1 from public.team_thread_participants tp where tp.thread_id = t.id)
-- group by t.id
-- having count(distinct m.sender_id) <= 2;
