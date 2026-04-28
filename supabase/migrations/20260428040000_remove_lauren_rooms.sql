-- Remove Lauren rooms — Lauren stops creating new shared threads.
-- All teammate-bound messages flow through the existing caller↔target DM
-- (relay_to_user) and surface in the Chat tab. Existing lauren_room
-- threads are archived (not deleted) so message history is preserved.
--
-- Rationale (Justin, 2026-04-28): Lauren is an agent. The team Chat is
-- where humans talk to each other. Letting Lauren spawn lauren_room
-- threads created a parallel chat surface that fragmented attention and
-- made Justin miss messages — exact bug observed today. Folding loop-in
-- into relay (with longer briefing-style bodies) keeps Lauren in her
-- lane and gives the Chat tab a single source of truth for unread state.

-- ── 1. Archive existing lauren_room threads ──────────────────────────────
-- Preserve message history; just hide them from the active thread list.
update public.team_threads
   set archived_at = coalesce(archived_at, now())
 where thread_type = 'lauren_room'
   and archived_at is null;

-- ── 2. Drop the loop_in_teammate branch from lauren_execute_action ───────
-- Anything still in lauren_pending_actions with action_type='loop_in_teammate'
-- can no longer be executed. Cancel any leftover pending rows so they don't
-- show ghost cards in the FAB.
update public.lauren_pending_actions
   set status = 'cancelled', decided_at = now(),
       result = jsonb_build_object('cancelled_reason', 'loop_in_teammate removed — relay through DM instead')
 where action_type = 'loop_in_teammate'
   and status = 'pending';

-- Tighten the action_type check constraint to disallow new loop_in_teammate.
alter table public.lauren_pending_actions
  drop constraint if exists lauren_pending_actions_action_type_check;
alter table public.lauren_pending_actions
  add constraint lauren_pending_actions_action_type_check
  check (action_type in (
    'update_deal_status',
    'create_task',
    'update_deal_meta',
    'relay_to_user',
    'send_sms',
    'send_email',
    'generate_personalized_url'
  ));

-- ── 3. Rewrite lauren_execute_action without the loop_in_teammate branch ─
-- Keep relay_to_user as the canonical teammate-messaging path.
create or replace function public.lauren_execute_action(p_action_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_action record;
  v_payload jsonb;
  v_caller uuid := auth.uid();
  v_result jsonb;
  v_dm_thread uuid;
begin
  select * into v_action from public.lauren_pending_actions where id = p_action_id;
  if v_action is null then raise exception 'action not found'; end if;
  if v_action.status <> 'pending' then raise exception 'action already %', v_action.status; end if;

  v_payload := v_action.action_payload;

  begin
    if v_action.action_type = 'update_deal_status' then
      update public.deals set status = (v_payload->>'status') where id = (v_payload->>'deal_id');
      v_result := jsonb_build_object('ok', true, 'updated', 'deals.status');
      insert into public.activity (deal_id, user_id, action) values (
        v_payload->>'deal_id', v_caller,
        format('Status changed to %s by %s (proposed by Lauren)', v_payload->>'status',
          coalesce((select name from public.profiles where id = v_caller), 'team'))
      );
    elsif v_action.action_type = 'update_deal_meta' then
      update public.deals
        set meta = coalesce(meta, '{}'::jsonb) || (v_payload->'meta_patch')
        where id = (v_payload->>'deal_id');
      v_result := jsonb_build_object('ok', true, 'updated', 'deals.meta');
    elsif v_action.action_type = 'create_task' then
      insert into public.tasks (deal_id, title, due_date, assigned_to)
      values (
        v_payload->>'deal_id',
        v_payload->>'title',
        (v_payload->>'due_date')::date,
        v_payload->>'assigned_to'
      )
      returning jsonb_build_object('task_id', id) into v_result;
    elsif v_action.action_type = 'relay_to_user' then
      v_dm_thread := public.lauren_find_or_create_dm_with(
        (v_payload->>'from_user_id')::uuid,
        (v_payload->>'to_user_id')::uuid
      );
      insert into public.team_messages (thread_id, sender_id, sender_kind, body)
      values (v_dm_thread, null, 'lauren', v_payload->>'body');
      v_result := jsonb_build_object('ok', true, 'relayed_to_thread', v_dm_thread);
    else
      raise exception 'unknown action type: %', v_action.action_type;
    end if;

    update public.lauren_pending_actions
      set status = 'executed', decided_at = now(), decided_by = v_caller, result = v_result
      where id = p_action_id;
    return v_result;
  exception when others then
    update public.lauren_pending_actions
      set status = 'failed', decided_at = now(), decided_by = v_caller,
          result = jsonb_build_object('error', sqlerrm)
      where id = p_action_id;
    return jsonb_build_object('error', sqlerrm);
  end;
end;
$$;
grant execute on function public.lauren_execute_action(uuid) to authenticated;

-- ── 4. Drop the now-orphan room creation function ────────────────────────
drop function if exists public.lauren_create_room_with(uuid, uuid, text);

-- Note: thread_type='lauren_room' stays valid in the team_threads check
-- constraint so the archived rows remain queryable. We just don't insert
-- new ones from anywhere in the codebase.
