-- Per-user notification preferences for the mobile push triggers.
-- Three booleans, default ON. Stored as jsonb so we can add more
-- event types later without another migration.
--
-- Used by:
--   - tg_push_notify_inbound_sms       (key: 'sms')
--   - tg_push_notify_team_message      (key: 'team')
--   - tg_push_notify_inbound_call      (key: 'calls')

alter table public.profiles
  add column if not exists notification_prefs jsonb not null
    default '{"sms": true, "calls": true, "team": true}'::jsonb;

-- Backfill is implicit because of the default — existing rows now
-- have the default value applied.

comment on column public.profiles.notification_prefs is
  'Mobile push toggles. Keys: sms, calls, team. All default true. '
  'Triggers exclude a user from broadcasts when their key is false.';

-- Helper view: which user ids should get pushed for each event type.
-- Triggers use this to filter their recipient lists instead of
-- inlining the jsonb check, which keeps trigger code readable.
create or replace function public.notification_recipients(p_event text)
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select id
  from public.profiles
  where role in ('admin', 'user', 'va')
    and coalesce(
      (notification_prefs ->> p_event)::boolean,
      true  -- defaults to opted-in if the key is missing
    ) is true
$$;

comment on function public.notification_recipients is
  'Returns user ids that should be pushed for the given event type. '
  'Honors profiles.notification_prefs per-user opt-outs.';

-- Rewrite the three trigger functions to use the helper.
-- 1. Inbound SMS
create or replace function public.tg_push_notify_inbound_sms()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_supabase_url text := 'https://rcfaashkfpurkvtmsmeb.supabase.co';
  v_endpoint text;
  v_team_ids uuid[];
  v_sender_name text;
  v_body_preview text;
  v_payload jsonb;
begin
  if new.direction is distinct from 'inbound' then return new; end if;

  select array_agg(id)
    into v_team_ids
    from public.notification_recipients('sms') as id;
  if v_team_ids is null or cardinality(v_team_ids) = 0 then return new; end if;

  select coalesce(c.name, c.company)
    into v_sender_name
    from public.contacts c
   where c.id = new.contact_id
   limit 1;
  if v_sender_name is null and new.from_number is not null then
    select coalesce(c.name, c.company)
      into v_sender_name
      from public.contacts c
     where c.phone = new.from_number
        or c.phone = regexp_replace(new.from_number, '^\+1', '')
     limit 1;
  end if;
  if v_sender_name is null then v_sender_name := new.from_number; end if;

  v_body_preview := substr(coalesce(new.body, ''), 1, 120);

  v_payload := jsonb_build_object(
    'user_ids',  to_jsonb(v_team_ids),
    'title',     coalesce(v_sender_name, 'New message'),
    'body',      v_body_preview,
    'data', jsonb_build_object(
      'type',       'sms',
      'thread_key', new.thread_key,
      'deal_id',    new.deal_id,
      'contact_id', new.contact_id,
      'message_id', new.id
    ),
    'sound', 'default'
  );

  v_endpoint := v_supabase_url || '/functions/v1/send-push-notification';
  perform net.http_post(
    url     := v_endpoint,
    body    := v_payload,
    headers := jsonb_build_object('Content-Type', 'application/json')
  );
  return new;
end;
$$;

-- 2. Team chat
create or replace function public.tg_push_notify_team_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_supabase_url text := 'https://rcfaashkfpurkvtmsmeb.supabase.co';
  v_endpoint text;
  v_thread_type text;
  v_thread_title text;
  v_recipient_ids uuid[];
  v_sender_name text;
  v_body_preview text;
  v_payload jsonb;
begin
  if new.sender_kind = 'lauren' then return new; end if;
  if new.deleted_at is not null then return new; end if;

  select thread_type, title
    into v_thread_type, v_thread_title
    from public.team_threads
   where id = new.thread_id;

  if v_thread_type in ('lauren_dm', 'lauren_room') then return new; end if;

  -- Combine the thread participants (or all team users for open
  -- channels) with the per-user notification_prefs check.
  with eligible_users as (
    select id from public.notification_recipients('team') as id
  ),
  thread_users as (
    select user_id as id
      from public.team_thread_participants
     where thread_id = new.thread_id
       and user_id is distinct from new.sender_id
  ),
  fallback_users as (
    select id
      from public.profiles
     where role in ('admin', 'user', 'va')
       and id is distinct from new.sender_id
  )
  select array_agg(distinct id)
    into v_recipient_ids
    from eligible_users
   where id in (
     select id from thread_users
     union
     select id from fallback_users
     where not exists (select 1 from thread_users)
   );

  if v_recipient_ids is null or cardinality(v_recipient_ids) = 0 then
    return new;
  end if;

  select coalesce(display_name, name, 'team')
    into v_sender_name
    from public.profiles
   where id = new.sender_id;
  if v_sender_name is null then v_sender_name := 'Team'; end if;

  v_body_preview := substr(coalesce(new.body, ''), 1, 120);

  v_payload := jsonb_build_object(
    'user_ids',  to_jsonb(v_recipient_ids),
    'title',     case
                   when v_thread_type = 'channel'
                   then '[# ' || coalesce(v_thread_title, 'team') || '] ' || v_sender_name
                   else v_sender_name
                 end,
    'body',      v_body_preview,
    'data', jsonb_build_object(
      'type',       'team',
      'thread_id',  new.thread_id,
      'message_id', new.id
    ),
    'sound', 'default'
  );

  v_endpoint := v_supabase_url || '/functions/v1/send-push-notification';
  perform net.http_post(
    url     := v_endpoint,
    body    := v_payload,
    headers := jsonb_build_object('Content-Type', 'application/json')
  );
  return new;
end;
$$;

-- 3. Inbound call
create or replace function public.tg_push_notify_inbound_call()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_supabase_url text := 'https://rcfaashkfpurkvtmsmeb.supabase.co';
  v_endpoint text;
  v_team_ids uuid[];
  v_caller_name text;
  v_deal_name text;
  v_payload jsonb;
  v_title text;
  v_body text;
begin
  if new.direction is distinct from 'inbound' then return new; end if;
  if new.status is distinct from 'ringing' then return new; end if;

  select array_agg(id)
    into v_team_ids
    from public.notification_recipients('calls') as id;
  if v_team_ids is null or cardinality(v_team_ids) = 0 then return new; end if;

  select coalesce(c.name, c.company)
    into v_caller_name
    from public.contacts c
   where c.id = new.contact_id
   limit 1;
  if v_caller_name is null and new.from_number is not null then
    select coalesce(c.name, c.company)
      into v_caller_name
      from public.contacts c
     where c.phone = new.from_number
        or c.phone = regexp_replace(new.from_number, '^\+1', '')
     limit 1;
  end if;
  if v_caller_name is null then
    v_caller_name := coalesce(new.from_number, 'Unknown caller');
  end if;

  if new.deal_id is not null then
    select coalesce(d.name, d.id)
      into v_deal_name
      from public.deals d
     where d.id = new.deal_id;
  end if;

  v_title := '📞 Incoming: ' || v_caller_name;
  v_body := case
              when v_deal_name is not null then 'About: ' || v_deal_name
              else 'No deal linked — tap to triage'
            end;

  v_payload := jsonb_build_object(
    'user_ids',  to_jsonb(v_team_ids),
    'title',     v_title,
    'body',      v_body,
    'data', jsonb_build_object(
      'type',       'call',
      'deal_id',    new.deal_id,
      'contact_id', new.contact_id,
      'call_id',    new.id,
      'from_number', new.from_number
    ),
    'sound', 'default'
  );

  v_endpoint := v_supabase_url || '/functions/v1/send-push-notification';
  perform net.http_post(
    url     := v_endpoint,
    body    := v_payload,
    headers := jsonb_build_object('Content-Type', 'application/json')
  );
  return new;
end;
$$;
