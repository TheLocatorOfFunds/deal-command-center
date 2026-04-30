-- team_unread_count() — total unread team-chat messages for the caller.
--
-- Per Nathan 2026-04-30: he was missing DMs + #Ops messages because
-- the 💬 Chat button in the header has no unread indicator. This RPC
-- returns a single integer the App can render as a badge next to Chat.
--
-- "Unread" = messages in any thread the caller participates in, where
-- the sender isn't them, the message isn't deleted, and the message
-- was created after their last_read_at for that thread (or they have
-- no read row at all).
--
-- SECURITY DEFINER so the count is exact even though caller may not
-- have direct SELECT on team_message_reads for other users (they
-- shouldn't — the count is computed from THEIR own reads only).

create or replace function public.team_unread_count()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::int
  from team_messages tm
  where tm.deleted_at is null
    and tm.sender_id is distinct from auth.uid()
    and tm.thread_id in (
      select thread_id from team_thread_participants where user_id = auth.uid()
    )
    and tm.created_at > coalesce(
      (select last_read_at from team_message_reads
        where thread_id = tm.thread_id and user_id = auth.uid()),
      '-infinity'::timestamptz
    );
$$;

grant execute on function public.team_unread_count() to authenticated;
