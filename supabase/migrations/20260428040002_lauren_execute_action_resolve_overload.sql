-- Lands the live RPC fix from Apr 28 2026.
--
-- Symptom: clicking ✓ Confirm on a Lauren proposal threw
--   "Could not choose the best candidate function between
--    public.lauren_execute_action(p_action_id => uuid),
--    public.lauren_execute_action(p_action_id => uuid, p_caller_id => uuid)"
-- because two overloads existed and the client call (one arg) matched both.
--
-- Cause: the fixup migration in PR #24
-- (20260428040001_remove_lauren_rooms_fixup.sql) did
-- CREATE OR REPLACE on lauren_execute_action(p_action_id uuid) — but the
-- canonical version in prod was the 2-arg variant
-- (p_action_id uuid, p_caller_id uuid DEFAULT NULL::uuid). Postgres resolved
-- the CREATE as a NEW overload instead of replacing, leaving both in place.
--
-- Fix: drop the 1-arg form and patch the canonical 2-arg form's
-- loop_in_teammate branch (which still tried to call the now-dropped
-- lauren_create_room_with) to redirect through the DM.
--
-- Already applied to prod. This commit lands the SQL in the migration
-- history so the source matches reality.

-- ── 1. Remove the dupe 1-arg overload ────────────────────────────────────
drop function if exists public.lauren_execute_action(uuid);

-- ── 2. Replace the canonical 2-arg version with the loop_in_teammate ─────
-- branch redirecting to the DM (no more lauren_create_room_with calls).
-- All other branches (relay_to_user, send_sms, send_email,
-- generate_personalized_url, update_deal_status, update_deal_meta,
-- create_task) preserved verbatim.
create or replace function public.lauren_execute_action(p_action_id uuid, p_caller_id uuid default null::uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_action record;
  v_payload jsonb;
  v_caller uuid := coalesce(p_caller_id, auth.uid());
  v_result jsonb;
  v_dm_thread uuid;
  v_token text;
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
      update public.deals set meta = coalesce(meta, '{}'::jsonb) || (v_payload->'meta_patch')
        where id = (v_payload->>'deal_id');
      v_result := jsonb_build_object('ok', true, 'updated', 'deals.meta');
    elsif v_action.action_type = 'create_task' then
      insert into public.tasks (deal_id, title, due_date, assigned_to)
      values (v_payload->>'deal_id', v_payload->>'title', (v_payload->>'due_date')::date, v_payload->>'assigned_to')
      returning jsonb_build_object('task_id', id) into v_result;
    elsif v_action.action_type = 'relay_to_user' then
      v_dm_thread := public.lauren_find_or_create_dm_with(
        (v_payload->>'from_user_id')::uuid,
        (v_payload->>'to_user_id')::uuid);
      insert into public.team_messages (thread_id, sender_id, sender_kind, body)
      values (v_dm_thread, null, 'lauren', v_payload->>'body');
      v_result := jsonb_build_object('ok', true, 'relayed_to_thread', v_dm_thread);
    elsif v_action.action_type = 'loop_in_teammate' then
      -- Lauren-rooms removed (Justin 2026-04-28). Redirect any stale
      -- pending loop_in rows through the DM so they still do something
      -- useful instead of erroring on the dropped lauren_create_room_with.
      v_dm_thread := public.lauren_find_or_create_dm_with(
        coalesce((v_payload->>'caller_id')::uuid, v_caller),
        (v_payload->>'target_user_id')::uuid);
      insert into public.team_messages (thread_id, sender_id, sender_kind, body)
      values (v_dm_thread, null, 'lauren', coalesce(v_payload->>'intro', '(loop-in had no body)'));
      v_result := jsonb_build_object('ok', true, 'relayed_to_thread', v_dm_thread, 'note', 'loop_in redirected to DM');
    elsif v_action.action_type = 'generate_personalized_url' then
      v_token := public.lauren_generate_personalized_url(v_payload->>'deal_id');
      v_result := jsonb_build_object('ok', true, 'token', v_token, 'url', 'https://refundlocators.com/s/' || v_token);
    elsif v_action.action_type = 'send_sms' then
      perform net.http_post(
        url := 'https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/send-sms',
        headers := jsonb_build_object('Content-Type','application/json',
          'Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key' limit 1)),
        body := jsonb_build_object('to', v_payload->>'to', 'body', v_payload->>'body',
          'deal_id', v_payload->>'deal_id', 'contact_id', v_payload->>'contact_id'),
        timeout_milliseconds := 30000);
      v_result := jsonb_build_object('ok', true, 'sms_dispatched_to', v_payload->>'to');
    elsif v_action.action_type = 'send_email' then
      perform net.http_post(
        url := 'https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/send-email',
        headers := jsonb_build_object('Content-Type','application/json',
          'Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key' limit 1)),
        body := jsonb_build_object('to', v_payload->>'to', 'subject', v_payload->>'subject',
          'body', v_payload->>'body', 'deal_id', v_payload->>'deal_id'),
        timeout_milliseconds := 30000);
      v_result := jsonb_build_object('ok', true, 'email_dispatched_to', v_payload->>'to');
    else
      raise exception 'unknown action type: %', v_action.action_type;
    end if;
    update public.lauren_pending_actions set status = 'executed', decided_at = now(), decided_by = v_caller, result = v_result
      where id = p_action_id;
    return v_result;
  exception when others then
    update public.lauren_pending_actions set status = 'failed', decided_at = now(), decided_by = v_caller,
        result = jsonb_build_object('error', sqlerrm) where id = p_action_id;
    return jsonb_build_object('error', sqlerrm);
  end;
end;
$$;
grant execute on function public.lauren_execute_action(uuid, uuid) to authenticated;
