-- Lauren Rooms: multi-party threads where Nathan + a teammate + Lauren
-- chat together. Replaces the propose_relay_to_teammate flow with a
-- propose_loop_in_teammate flow that creates a real shared thread.
-- Lauren goes quiet in these rooms (only responds on @lauren).

-- New thread_type for Lauren-mediated rooms.
alter table public.team_threads drop constraint if exists team_threads_thread_type_check;
alter table public.team_threads add constraint team_threads_thread_type_check
  check (thread_type in ('channel','dm','deal','lauren_dm','lauren_room'));

-- New action_type for the loop-in propose tool.
alter table public.lauren_pending_actions
  drop constraint if exists lauren_pending_actions_action_type_check;
alter table public.lauren_pending_actions
  add constraint lauren_pending_actions_action_type_check
  check (action_type in (
    'update_deal_status',
    'create_task',
    'update_deal_meta',
    'relay_to_user',
    'loop_in_teammate'
  ));

-- Create a lauren_room thread between caller + target user, post an
-- intro message authored by Lauren as the first turn. Returns the new
-- thread_id.
create or replace function public.lauren_create_room_with(
  p_caller_id uuid,
  p_target_user_id uuid,
  p_intro text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_thread_id uuid;
  v_caller_name text;
  v_target_name text;
  v_title text;
begin
  if p_caller_id is null or p_target_user_id is null then
    raise exception 'caller and target are required';
  end if;
  if p_caller_id = p_target_user_id then
    raise exception 'cannot loop yourself in';
  end if;

  select coalesce(display_name, name, 'Caller')   into v_caller_name from public.profiles where id = p_caller_id;
  select coalesce(display_name, name, 'Teammate') into v_target_name from public.profiles where id = p_target_user_id;
  v_title := v_caller_name || ' + ' || v_target_name || ' · 🤖';

  insert into public.team_threads (title, thread_type, lauren_enabled, created_by_id)
  values (v_title, 'lauren_room', true, p_caller_id)
  returning id into v_thread_id;

  insert into public.team_thread_participants (thread_id, user_id) values
    (v_thread_id, p_caller_id),
    (v_thread_id, p_target_user_id);

  if p_intro is not null and length(trim(p_intro)) > 0 then
    insert into public.team_messages (thread_id, sender_id, sender_kind, body)
    values (v_thread_id, null, 'lauren', p_intro);
  end if;

  return v_thread_id;
end;
$$;
grant execute on function public.lauren_create_room_with(uuid, uuid, text) to authenticated, service_role;

-- Extend lauren_execute_action with 'loop_in_teammate' branch.
-- Payload: { caller_id, target_user_id, intro }
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
  v_room_thread uuid;
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
      v_room_thread := public.lauren_create_room_with(
        (v_payload->>'caller_id')::uuid,
        (v_payload->>'target_user_id')::uuid,
        v_payload->>'intro'
      );
      v_result := jsonb_build_object('ok', true, 'room_thread_id', v_room_thread);
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

-- Update the @-mention trigger: in lauren_room threads, Lauren is QUIET
-- by default — she only fires when explicitly @-mentioned (same regex
-- as other rooms). lauren_dm stays always-respond.
create or replace function public.tg_lauren_team_respond()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_thread record;
  v_url text := 'https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/lauren-team-respond';
begin
  if NEW.sender_kind = 'lauren' then return NEW; end if;
  if NEW.deleted_at is not null then return NEW; end if;
  select * into v_thread from public.team_threads where id = NEW.thread_id;
  if v_thread is null or v_thread.lauren_enabled is not true then return NEW; end if;
  -- Hub mode: Lauren always responds in her solo lauren_dm. In rooms
  -- (lauren_room) and other thread types, she only fires when @-mentioned.
  if v_thread.thread_type <> 'lauren_dm'
     and not public.lauren_is_mentioned(NEW.body)
  then
    return NEW;
  end if;

  begin
    perform net.http_post(
      url := v_url,
      headers := jsonb_build_object('Content-Type','application/json'),
      body := jsonb_build_object('thread_id', NEW.thread_id, 'message_id', NEW.id),
      timeout_milliseconds := 30000
    );
  exception when others then
    raise notice 'lauren-team-respond fire-and-forget failed: %', sqlerrm;
  end;
  return NEW;
end;
$$;
