-- ─────────────────────────────────────────────────────────────────────
-- 20260516120000_notifications_system
--
-- The mobile notification backbone. One table, one user-scoped index pattern,
-- 4 read-tracking RPCs, 2 aggregate views, 2 trigger sources (inbound SMS
-- and team_messages). Fires the existing send-push-notification edge fn
-- via pg_net for each notification insert.
--
-- See docs/MOBILE_NOTIFICATION_SYSTEM.md for design context, scope, and
-- the deferred Build 8+ items (docket_event, deal_status_change,
-- missed_call, system_alert triggers + smart batching + grouping).
-- ─────────────────────────────────────────────────────────────────────

-- pg_net is needed for trigger-fired HTTP calls to the edge fn.
create extension if not exists pg_net with schema extensions;

-- ─── Core table ──────────────────────────────────────────────────────
create table if not exists public.notifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  kind        text not null check (kind in (
    'inbound_sms',
    'docket_event',
    'team_message',
    'deal_status_change',
    'missed_call',
    'system_alert'
  )),
  deal_id     text references public.deals(id) on delete cascade,
  thread_id   uuid,
  title       text not null,
  body        text,
  data        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  read_at     timestamptz
);

create index if not exists notifications_user_unread_idx
  on public.notifications(user_id, created_at desc)
  where read_at is null;

create index if not exists notifications_user_all_idx
  on public.notifications(user_id, created_at desc);

create index if not exists notifications_deal_unread_idx
  on public.notifications(deal_id, user_id)
  where read_at is null;

comment on table public.notifications is
  'Per-user notification feed. Inserted by SECURITY DEFINER triggers from messages_outbound (inbound) and team_messages. Read-tracking via mark_*_read RPCs. Realtime-subscribed by the mobile app for badge counts and notification center.';

-- ─── RLS ─────────────────────────────────────────────────────────────
alter table public.notifications enable row level security;

drop policy if exists notifications_select_own on public.notifications;
create policy notifications_select_own on public.notifications
  for select using (user_id = auth.uid() or public.is_admin());

drop policy if exists notifications_update_own on public.notifications;
create policy notifications_update_own on public.notifications
  for update using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists notifications_admin_all on public.notifications;
create policy notifications_admin_all on public.notifications
  for all using (public.is_admin()) with check (public.is_admin());

-- No client-facing INSERT policy — only triggers (SECURITY DEFINER)
-- and service_role can insert.

-- ─── Read-tracking RPCs ──────────────────────────────────────────────
create or replace function public.mark_notification_read(p_notification_id uuid)
returns void
language sql
security invoker
set search_path = public
as $$
  update public.notifications
     set read_at = now()
   where id = p_notification_id
     and user_id = auth.uid()
     and read_at is null;
$$;

create or replace function public.mark_all_read()
returns int
language sql
security invoker
set search_path = public
as $$
  with upd as (
    update public.notifications
       set read_at = now()
     where user_id = auth.uid()
       and read_at is null
    returning 1
  )
  select count(*)::int from upd;
$$;

create or replace function public.mark_deal_read(p_deal_id text)
returns int
language sql
security invoker
set search_path = public
as $$
  with upd as (
    update public.notifications
       set read_at = now()
     where user_id = auth.uid()
       and deal_id = p_deal_id
       and read_at is null
    returning 1
  )
  select count(*)::int from upd;
$$;

create or replace function public.mark_thread_read(p_thread_id uuid)
returns int
language sql
security invoker
set search_path = public
as $$
  with upd as (
    update public.notifications
       set read_at = now()
     where user_id = auth.uid()
       and thread_id = p_thread_id
       and read_at is null
    returning 1
  )
  select count(*)::int from upd;
$$;

grant execute on function public.mark_notification_read(uuid) to authenticated;
grant execute on function public.mark_all_read()              to authenticated;
grant execute on function public.mark_deal_read(text)         to authenticated;
grant execute on function public.mark_thread_read(uuid)       to authenticated;

-- ─── Aggregate views ─────────────────────────────────────────────────
create or replace view public.v_user_unread_count as
select user_id, count(*)::int as unread_count
from public.notifications
where read_at is null
group by user_id;

create or replace view public.v_deal_unread_for_user as
select user_id, deal_id, count(*)::int as unread_count
from public.notifications
where read_at is null and deal_id is not null
group by user_id, deal_id;

grant select on public.v_user_unread_count   to authenticated;
grant select on public.v_deal_unread_for_user to authenticated;

-- ─── Helper: get all admin user IDs (broadcast targets) ──────────────
create or replace function public.notification_admin_user_ids()
returns setof uuid
language sql
security definer
stable
set search_path = public
as $$
  select id from public.profiles where role in ('admin', 'user');
$$;

-- ─── Trigger: inbound SMS → notification per admin ───────────────────
create or replace function public.tg_notify_inbound_sms()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_contact_name text;
  v_title        text;
  v_body         text;
  v_admins       uuid[];
  v_payload      jsonb;
begin
  -- Only inbound, only if body or media_url is present
  if new.direction <> 'inbound' then return new; end if;

  -- Skip STOP-keyword inbound (DND path)
  if lower(trim(coalesce(new.body, ''))) ~ '^(stop|unsubscribe|quit|end|cancel|opt[ ]?out|stopall)\b' then
    return new;
  end if;

  -- Resolve sender display
  if new.contact_id is not null then
    select coalesce(name, phone) into v_contact_name
      from public.contacts where id = new.contact_id;
  end if;
  v_title := coalesce(v_contact_name, new.to_number, 'Unknown number');

  v_body := substr(coalesce(new.body, '(image)'), 1, 100);

  -- All admins
  select array_agg(id) into v_admins from public.notification_admin_user_ids() as id;
  if v_admins is null or array_length(v_admins, 1) is null then return new; end if;

  -- Insert one row per admin
  insert into public.notifications (user_id, kind, deal_id, title, body, data)
    select aid,
           'inbound_sms',
           new.deal_id,
           v_title,
           v_body,
           jsonb_build_object(
             'type',       'sms',
             'target',     'deal/comms',
             'deal_id',    new.deal_id,
             'thread_key', new.thread_key,
             'message_id', new.id,
             'contact_id', new.contact_id
           )
      from unnest(v_admins) as aid;

  -- Fire push notification (best-effort; ignore HTTP errors)
  v_payload := jsonb_build_object(
    'user_ids', to_jsonb(v_admins),
    'title',    v_title,
    'body',     v_body,
    'data',     jsonb_build_object(
                  'type',       'sms',
                  'target',     'deal/comms',
                  'deal_id',    new.deal_id,
                  'thread_key', new.thread_key,
                  'message_id', new.id
                )
  );
  perform net.http_post(
    url     := 'https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/send-push-notification',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body    := v_payload
  );

  return new;
exception when others then
  -- Never let notification dispatch break the inbound write
  raise warning 'tg_notify_inbound_sms failed: %', sqlerrm;
  return new;
end;
$$;

drop trigger if exists tg_notify_inbound_sms on public.messages_outbound;
create trigger tg_notify_inbound_sms
  after insert on public.messages_outbound
  for each row
  when (new.direction = 'inbound')
  execute function public.tg_notify_inbound_sms();

-- ─── Trigger: team_messages → notification per admin (except sender) ─
create or replace function public.tg_notify_team_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sender_name text;
  v_title       text;
  v_body        text;
  v_recipients  uuid[];
  v_payload     jsonb;
begin
  -- Skip system messages (no human author)
  if new.sender_kind = 'system' then return new; end if;

  -- Resolve sender name
  if new.sender_id is not null then
    select coalesce(display_name, name, 'Team') into v_sender_name
      from public.profiles where id = new.sender_id;
  end if;
  v_title := coalesce(v_sender_name, 'Team chat');
  v_body  := substr(coalesce(new.body, ''), 1, 100);
  if length(v_body) = 0 then return new; end if;

  -- Recipients: all admins except sender
  select array_agg(id)
    into v_recipients
    from public.profiles
   where role in ('admin', 'user')
     and (new.sender_id is null or id <> new.sender_id);

  if v_recipients is null or array_length(v_recipients, 1) is null then
    return new;
  end if;

  insert into public.notifications (user_id, kind, thread_id, title, body, data)
    select rid,
           'team_message',
           new.thread_id,
           v_title,
           v_body,
           jsonb_build_object(
             'type',       'team',
             'target',     'team/thread',
             'thread_id',  new.thread_id,
             'message_id', new.id
           )
      from unnest(v_recipients) as rid;

  v_payload := jsonb_build_object(
    'user_ids', to_jsonb(v_recipients),
    'title',    v_title,
    'body',     v_body,
    'data',     jsonb_build_object(
                  'type',       'team',
                  'target',     'team/thread',
                  'thread_id',  new.thread_id,
                  'message_id', new.id
                )
  );
  perform net.http_post(
    url     := 'https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/send-push-notification',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body    := v_payload
  );

  return new;
exception when others then
  raise warning 'tg_notify_team_message failed: %', sqlerrm;
  return new;
end;
$$;

drop trigger if exists tg_notify_team_message on public.team_messages;
create trigger tg_notify_team_message
  after insert on public.team_messages
  for each row
  execute function public.tg_notify_team_message();
