-- Lauren capability expansion: SMS, email, generate personalized URL,
-- read documents — plus a per-user "bypass mode" so Nathan/Justin can
-- decide if Lauren needs to wait for confirms or can act immediately.
--
-- Bypass mode is per-user (lives on profiles), so Nathan can run with
-- bypass ON while Justin runs with bypass OFF, or vice versa. When ON,
-- the EF auto-fires lauren_execute_action right after creating the
-- pending action, so the user sees "EXECUTED" instead of "AWAITING
-- CONFIRM" — no manual click needed.

-- 1. Per-user bypass toggle. Default false (safe — confirms required).
alter table public.profiles
  add column if not exists lauren_bypass_mode boolean not null default false;

-- 2. Widen action_type to allow the new capabilities.
alter table public.lauren_pending_actions
  drop constraint if exists lauren_pending_actions_action_type_check;
alter table public.lauren_pending_actions
  add constraint lauren_pending_actions_action_type_check
  check (action_type in (
    'update_deal_status',
    'create_task',
    'update_deal_meta',
    'relay_to_user',
    'loop_in_teammate',
    'send_sms',
    'send_email',
    'generate_personalized_url'
  ));

-- 3. Helper RPC: generate a personalized_links row for a deal.
-- Same logic as the PersonalizedUrlControl frontend button — pulls
-- name/address/county/etc from the deal and meta, generates an 8-char
-- token, inserts a personalized_links row. Trigger sync_refundlocators_token
-- copies the token to deals.refundlocators_token automatically.
create or replace function public.lauren_generate_personalized_url(p_deal_id text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deal record;
  v_token text;
  v_meta jsonb;
  v_first text;
  v_last text;
  v_phone_clean text;
  v_phone_e164 text;
  v_alphabet text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  i int;
begin
  select * into v_deal from public.deals where id = p_deal_id;
  if v_deal is null then raise exception 'deal not found: %', p_deal_id; end if;

  -- 8-char nanoid-style token (URL-safe alphabet)
  v_token := '';
  for i in 1..8 loop
    v_token := v_token || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
  end loop;

  v_meta := coalesce(v_deal.meta, '{}'::jsonb);
  v_first := split_part(coalesce(v_deal.name, ''), ' ', 1);
  v_last  := nullif(trim(substr(coalesce(v_deal.name, ''), length(v_first) + 1)), '');
  v_phone_clean := regexp_replace(coalesce(v_meta->>'phone', v_meta->>'homeownerPhone', v_meta->>'contactPhone', ''), '\D', '', 'g');
  v_phone_e164 :=
    case
      when length(v_phone_clean) = 10 then '+1' || v_phone_clean
      when length(v_phone_clean) = 11 and substr(v_phone_clean, 1, 1) = '1' then '+' || v_phone_clean
      when length(v_phone_clean) > 0 then '+' || v_phone_clean
      else null
    end;

  insert into public.personalized_links (
    token, deal_id, first_name, last_name, phone, property_address, county,
    case_number, sale_date, sale_price, judgment_amount,
    estimated_surplus_low, estimated_surplus_high,
    source, expires_at
  ) values (
    v_token, v_deal.id, nullif(v_first, ''), v_last, v_phone_e164,
    v_deal.address, v_meta->>'county',
    coalesce(v_meta->>'courtCase', v_meta->>'caseNumber', v_meta->>'case_number'),
    nullif(v_meta->>'saleDate', '')::date,
    nullif(v_meta->>'salePrice', '')::numeric,
    nullif(v_meta->>'judgmentAmount', '')::numeric,
    nullif(v_meta->>'estimatedSurplusLow', '')::numeric,
    nullif(v_meta->>'estimatedSurplusHigh', '')::numeric,
    'lauren-generated',
    now() + interval '90 days'
  );

  return v_token;
end;
$$;
grant execute on function public.lauren_generate_personalized_url(text) to authenticated, service_role;

-- 4. Helper read: list documents on a deal. Lauren can summarize what's
-- there before Nathan asks "what files do we have on Casey Jennings?".
create or replace function public.lauren_list_documents(p_deal_id text)
returns table(id uuid, name text, mime_type text, size bigint, created_at timestamptz)
language sql
security definer
set search_path = public
as $$
  select id, name, mime_type, size, created_at
  from public.documents
  where deal_id = p_deal_id
  order by created_at desc
  limit 50;
$$;
grant execute on function public.lauren_list_documents(text) to authenticated, service_role;

-- 5. Helper read: get a signed URL for a document so Lauren can include
-- a link the user can click to open the file.
create or replace function public.lauren_get_document_url(p_document_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_doc record;
begin
  select * into v_doc from public.documents where id = p_document_id;
  if v_doc is null then raise exception 'document not found'; end if;
  -- We can't generate a signed URL from inside SQL — return the path
  -- and let the EF / client call storage.from('deal-docs').createSignedUrl.
  return jsonb_build_object(
    'document_id', v_doc.id,
    'name', v_doc.name,
    'path', v_doc.path,
    'mime_type', v_doc.mime_type,
    'deal_id', v_doc.deal_id
  );
end;
$$;
grant execute on function public.lauren_get_document_url(uuid) to authenticated, service_role;

-- 6. Extend lauren_execute_action with new branches.
-- Adds optional p_caller_id parameter so the EF can auto-execute in
-- bypass mode (where auth.uid() is null because the EF runs under the
-- service role). Manual confirm clicks from the frontend still pass
-- nothing and fall through to auth.uid() as before.
create or replace function public.lauren_execute_action(p_action_id uuid, p_caller_id uuid default null)
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
  v_room_thread uuid;
  v_token text;
  v_url text;
  v_resend_key text;
  v_response jsonb;
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
    elsif v_action.action_type = 'generate_personalized_url' then
      v_token := public.lauren_generate_personalized_url(v_payload->>'deal_id');
      v_result := jsonb_build_object(
        'ok', true,
        'token', v_token,
        'url', 'https://refundlocators.com/s/' || v_token
      );
    elsif v_action.action_type = 'send_sms' then
      -- Fire send-sms edge function via pg_net. Authentication via the
      -- service role key in vault — same pattern Justin uses elsewhere.
      perform net.http_post(
        url := 'https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/send-sms',
        headers := jsonb_build_object(
          'Content-Type','application/json',
          'Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key' limit 1)
        ),
        body := jsonb_build_object(
          'to', v_payload->>'to',
          'body', v_payload->>'body',
          'deal_id', v_payload->>'deal_id',
          'contact_id', v_payload->>'contact_id'
        ),
        timeout_milliseconds := 30000
      );
      v_result := jsonb_build_object('ok', true, 'sms_dispatched_to', v_payload->>'to');
    elsif v_action.action_type = 'send_email' then
      perform net.http_post(
        url := 'https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/send-email',
        headers := jsonb_build_object(
          'Content-Type','application/json',
          'Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key' limit 1)
        ),
        body := jsonb_build_object(
          'to', v_payload->>'to',
          'subject', v_payload->>'subject',
          'body', v_payload->>'body',
          'deal_id', v_payload->>'deal_id'
        ),
        timeout_milliseconds := 30000
      );
      v_result := jsonb_build_object('ok', true, 'email_dispatched_to', v_payload->>'to');
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

-- 7. RPC for the bypass-mode toggle so the FAB can flip it without
-- needing direct UPDATE on profiles (defensive — even though the
-- existing self-update policy would allow it, this is cleaner).
create or replace function public.set_lauren_bypass_mode(p_on boolean)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then raise exception 'not authenticated'; end if;
  update public.profiles set lauren_bypass_mode = coalesce(p_on, false) where id = v_user;
  return p_on;
end;
$$;
grant execute on function public.set_lauren_bypass_mode(boolean) to authenticated;

-- 8. RPC the EF can call to find out the calling user's bypass mode.
-- Service role would be able to read profiles directly but this keeps
-- the contract explicit.
create or replace function public.lauren_get_bypass_mode(p_user_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select coalesce(lauren_bypass_mode, false) from public.profiles where id = p_user_id;
$$;
grant execute on function public.lauren_get_bypass_mode(uuid) to authenticated, service_role;
