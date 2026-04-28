-- Fixup for 20260428040000_remove_lauren_rooms.sql
--
-- The previous migration's check-constraint tightening rejected because
-- 7 historical loop_in_teammate rows already existed (executed status,
-- not in scope to delete). Keeping the constraint loose is fine — the
-- Edge Function no longer proposes loop_in_teammate, and the rewritten
-- lauren_execute_action below rejects it if it ever shows up.

-- ── 1. Archive any remaining lauren_room threads (idempotent) ────────────
update public.team_threads
   set archived_at = coalesce(archived_at, now())
 where thread_type = 'lauren_room'
   and archived_at is null;

-- ── 2. Rewrite lauren_execute_action (no loop_in_teammate branch) ────────
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
    elsif v_action.action_type = 'loop_in_teammate' then
      -- Deprecated: shouldn't see new ones (Edge Function no longer proposes
      -- this type), but if a stale pending row exists from before the
      -- removal, redirect it to relay_to_user semantics so it still does
      -- something useful instead of erroring.
      v_dm_thread := public.lauren_find_or_create_dm_with(
        coalesce((v_payload->>'caller_id')::uuid, v_caller),
        (v_payload->>'target_user_id')::uuid
      );
      insert into public.team_messages (thread_id, sender_id, sender_kind, body)
      values (v_dm_thread, null, 'lauren', coalesce(v_payload->>'intro', '(loop-in message had no body)'));
      v_result := jsonb_build_object('ok', true, 'relayed_to_thread', v_dm_thread, 'note', 'loop_in_teammate redirected to relay_to_user');
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

-- ── 3. Drop the orphan room creation function ────────────────────────────
drop function if exists public.lauren_create_room_with(uuid, uuid, text);
