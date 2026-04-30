-- team_unread_per_thread() — per-thread unread counts for the caller.
--
-- Per Nathan 2026-04-30: the header badge shows total unreads, but
-- without per-thread badges in the sidebar, the user can't tell WHICH
-- thread has the unreads — so the count seems to "stick" because
-- they're clicking around blindly.
--
-- Returns one row per thread the caller participates in that has at
-- least one unread message. Threads with zero unreads are omitted to
-- keep the response small.

create or replace function public.team_unread_per_thread(p_user_id uuid)
returns table(thread_id uuid, unread_count integer)
language sql
stable
security definer
set search_path = public
as $$
  select
    tm.thread_id,
    count(*)::int as unread_count
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
    )
  group by tm.thread_id;
$$;

grant execute on function public.team_unread_per_thread(uuid) to authenticated;
