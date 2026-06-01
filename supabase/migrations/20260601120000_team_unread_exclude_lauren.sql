-- Fix: the 💬 Chat nav badge counted Lauren's autonomous agent messages as
-- "unread chat". Lauren posts to her DM / room threads on her own (proposals,
-- executions), which inflated the human unread badge even though the operator
-- has no human message to read — Nathan saw "Chat 3" with an empty inbox
-- (2026-06-01). Lauren's output already has its own surfaces (🔔 bell +
-- Lauren-flagged count), so it should not drive the conversational-unread badge.
--
-- Both the nav-badge RPC (team_unread_count) and the per-thread-dot RPC
-- (team_unread_per_thread) now exclude sender_kind='lauren'. Also align
-- team_unread_count with team_unread_per_thread by skipping archived threads
-- (an archived thread's unread messages were counting in the nav total but were
-- invisible/unclearable in the UI — a sibling phantom-unread).
-- A human message (sender_kind admin/va/NULL) in ANY thread still counts:
-- verified 110 human messages in Nathan's threads remain countable, 56 Lauren
-- + 7 archived excluded.

CREATE OR REPLACE FUNCTION public.team_unread_count(p_user_id uuid DEFAULT auth.uid())
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select count(*)::int
  from team_messages tm
  join team_threads tt on tt.id = tm.thread_id
  where tm.deleted_at is null
    and tt.archived_at is null
    and tm.sender_kind is distinct from 'lauren'
    and tm.sender_id is distinct from p_user_id
    and tm.thread_id in (
      select thread_id from team_thread_participants where user_id = p_user_id
    )
    and tm.created_at > coalesce(
      (select last_read_at from team_message_reads
        where thread_id = tm.thread_id and user_id = p_user_id),
      '-infinity'::timestamptz
    );
$function$;

CREATE OR REPLACE FUNCTION public.team_unread_per_thread(p_user_id uuid)
 RETURNS TABLE(thread_id uuid, unread_count integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select
    tm.thread_id,
    count(*)::int as unread_count
  from team_messages tm
  join team_threads tt on tt.id = tm.thread_id
  where tm.deleted_at is null
    and tt.archived_at is null
    and tm.sender_kind is distinct from 'lauren'
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
$function$;
