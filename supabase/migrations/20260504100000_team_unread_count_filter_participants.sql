-- Fix team_unread_count(p_user_id) to filter by participants.
--
-- The current implementation (from 20260427000000_team_chat_phase1.sql)
-- iterates ALL non-archived team_threads — including ones the user isn't
-- a participant of (e.g., other users' Lauren rooms, other DMs). For
-- threads where the user has no team_message_reads row, the function
-- counts EVERY non-self message → grossly inflates the badge.
--
-- This rewrite mirrors team_unread_per_thread's logic: only count
-- messages in threads the user is in, with `is distinct from` semantics
-- (which correctly treats NULL sender_id — Lauren messages — as "not me").
--
-- Symptom this fixes: header shows "💬 Chat 3" while the popover
-- (which already filters by participants) finds 0 of them.

create or replace function public.team_unread_count(p_user_id uuid default auth.uid())
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::int
  from team_messages tm
  where tm.deleted_at is null
    and tm.sender_id is distinct from p_user_id
    and tm.thread_id in (
      select thread_id from team_thread_participants where user_id = p_user_id
    )
    and tm.created_at > coalesce(
      (select last_read_at from team_message_reads
        where thread_id = tm.thread_id and user_id = p_user_id),
      '-infinity'::timestamptz
    );
$$;

grant execute on function public.team_unread_count(uuid) to authenticated;
