-- Lauren Hub Mode: per-user "Ask Lauren" DM where she's the always-on
-- exec assistant. Plus a propose_relay_to_user write tool so Lauren can
-- forward / cross-post to the user's actual teammates with confirm.

-- New thread_type for Lauren's per-user DM (always-respond, no @mention required)
alter table public.team_threads drop constraint if exists team_threads_thread_type_check;
alter table public.team_threads add constraint team_threads_thread_type_check
  check (thread_type in ('channel','dm','deal','lauren_dm'));

-- RPC: get or create the calling user's Lauren DM. Idempotent.
create or replace function public.lauren_get_or_create_dm()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_thread_id uuid;
  v_user uuid := auth.uid();
begin
  if v_user is null then raise exception 'not authenticated'; end if;

  select t.id into v_thread_id
    from public.team_threads t
    join public.team_thread_participants tp on tp.thread_id = t.id
   where t.thread_type = 'lauren_dm' and tp.user_id = v_user
   limit 1;
  if v_thread_id is not null then return v_thread_id; end if;

  insert into public.team_threads (title, thread_type, lauren_enabled, created_by_id)
  values ('🤖 Ask Lauren', 'lauren_dm', true, v_user)
  returning id into v_thread_id;

  insert into public.team_thread_participants (thread_id, user_id) values (v_thread_id, v_user);

  return v_thread_id;
end;
$$;
grant execute on function public.lauren_get_or_create_dm() to authenticated;

-- Update Lauren's mention trigger: skip the @-mention check when the thread
-- is a lauren_dm (Hub mode — she always responds there). Other thread
-- types still require the regex match.
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
  -- Hub mode: Lauren always responds in her own DM. Other threads still
  -- require explicit @-mention (or "Lauren," / "L:" at line start).
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

-- Lookup: get teammate user_ids by name fragment (so Lauren can resolve
-- "loop Justin in" to a real user_id). Restricted to admin/user/va roles.
create or replace function public.lauren_find_teammate(p_needle text)
returns table(user_id uuid, name text, display_name text, email text)
language sql
security definer
set search_path = public
as $$
  select p.id, p.name, p.display_name, u.email::text
  from public.profiles p
  join auth.users u on u.id = p.id
  where p.role in ('admin', 'user', 'va')
    and (
      p.name        ilike '%' || p_needle || '%'
      or p.display_name ilike '%' || p_needle || '%'
      or u.email    ilike '%' || p_needle || '%'
    )
  limit 5;
$$;
grant execute on function public.lauren_find_teammate(text) to authenticated, service_role;

-- Find or create the DM thread between current caller and a target user.
-- Reuses team_create_dm logic via direct query to keep the existing code
-- path intact. Returns the thread_id.
create or replace function public.lauren_find_or_create_dm_with(p_caller_id uuid, p_other_user uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_thread_id uuid;
  v_label text;
begin
  if p_caller_id is null or p_other_user is null then raise exception 'both users required'; end if;
  if p_caller_id = p_other_user then raise exception 'cannot DM yourself'; end if;

  select t.id into v_thread_id
    from public.team_threads t
   where t.thread_type = 'dm'
     and exists (select 1 from public.team_thread_participants tp where tp.thread_id = t.id and tp.user_id = p_caller_id)
     and exists (select 1 from public.team_thread_participants tp where tp.thread_id = t.id and tp.user_id = p_other_user)
     and (select count(*) from public.team_thread_participants where thread_id = t.id) = 2
   limit 1;
  if v_thread_id is not null then return v_thread_id; end if;

  select coalesce(p1.display_name, p1.name, 'You') || ' <-> ' ||
         coalesce(p2.display_name, p2.name, 'Teammate')
    from public.profiles p1, public.profiles p2
   where p1.id = p_caller_id and p2.id = p_other_user
    into v_label;

  insert into public.team_threads (title, thread_type, created_by_id)
  values (v_label, 'dm', p_caller_id)
  returning id into v_thread_id;

  insert into public.team_thread_participants (thread_id, user_id) values
    (v_thread_id, p_caller_id),
    (v_thread_id, p_other_user);

  return v_thread_id;
end;
$$;
grant execute on function public.lauren_find_or_create_dm_with(uuid, uuid) to authenticated, service_role;

-- Extend lauren_execute_action with a 'relay_to_user' branch.
-- Payload: { from_user_id, to_user_id, body }
-- Effect: insert a team_messages row in the DM between from + to,
--         labeled "via 🤖 Lauren" so recipient knows it was relayed.
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
      -- Find or create the DM between sender and target, then post the
      -- message there. Sender shows as Lauren so recipient sees a clear
      -- "this came via Lauren on behalf of <person>" frame.
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
