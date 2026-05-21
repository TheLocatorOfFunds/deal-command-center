-- Team chat: ad-hoc group threads (issue #176).
--
-- Per Justin 2026-05-20: the team chat needs a "group chat" affordance —
-- multi-participant threads that aren't a public channel and aren't 1:1.
-- After looking at the schema I realized the infrastructure was already
-- in place from the Lauren Rooms migration (20260427030700):
--
--   * team_threads.thread_type column with check ('channel','dm','deal',
--     'lauren_dm','lauren_room')
--   * team_thread_participants(thread_id, user_id, added_at)
--   * RLS on team_threads + team_messages already participant-aware:
--       - threads with ZERO rows in team_thread_participants → visible to
--         all admin/va (this is what makes a "channel")
--       - threads with N rows → visible only to those N users
--
-- So adding "group chats" is mostly a UI change. Schema-side, all this
-- migration does is widen the thread_type check constraint to accept
-- 'group' as a value. The rest of the system already routes group
-- threads correctly because:
--   * The Lauren-respond trigger only fires for lauren_dm / lauren_room
--     (doesn't accidentally activate on group threads)
--   * The team_threads RLS treats any participant-bearing thread the same
--     way regardless of thread_type
--
-- Why bother with the 'group' value at all then? Because the UI needs to
-- distinguish group threads from lauren_room threads (different icon,
-- different empty state, no Lauren in group chats). One column read.

alter table public.team_threads
  drop constraint if exists team_threads_thread_type_check;

alter table public.team_threads
  add constraint team_threads_thread_type_check
  check (thread_type in (
    'channel',
    'dm',
    'deal',
    'lauren_dm',
    'lauren_room',
    'group'           -- new: ad-hoc, user-named, multi-participant
  ));

comment on column public.team_threads.thread_type is
  'Kind of thread for UI routing and Lauren-respond gating. channel = role-gated, everyone-on-the-team sees it (no participants rows). dm = 1:1 between two users (two participants rows). group = ad-hoc multi-user thread (N participants rows). deal = thread bound to a deal. lauren_dm = solo conversation with Lauren. lauren_room = multi-party room with Lauren mediating. The participant-gating happens in team_threads RLS, not in this column.';
