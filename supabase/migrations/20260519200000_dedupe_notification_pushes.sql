-- ─────────────────────────────────────────────────────────────────────
-- 20260519200000_dedupe_notification_pushes
--
-- Fixes a conflict created by 20260516120000_notifications_system.sql.
-- That migration added two AFTER INSERT triggers (tg_notify_inbound_sms
-- on messages_outbound, tg_notify_team_message on team_messages) that
-- BOTH (a) inserted into the new `notifications` table AND (b) fired
-- a push notification via http_post.
--
-- Problem: pre-existing triggers (tg_push_notify_inbound_sms,
-- tg_push_notify_team_message) already handle push delivery with
-- smarter recipient resolution (notification_recipients() helper,
-- mention parsing, Lauren-skip, thread-participants lookup, etc.).
-- The combination meant every inbound SMS and every team_message was
-- firing 2-3 pushes for the same event.
--
-- Fix: trim my two triggers down to ONLY do the notifications-table
-- insert. Push delivery stays where it was — in the pre-existing
-- triggers. Net result:
--   - notifications table populated (drives in-app notification
--     center, app icon badge, per-deal indicator, team tab badge)
--   - exactly one push per event, via pre-existing logic that already
--     handles edge cases the right way
--
-- No table changes, no RLS changes. Just CREATE OR REPLACE on two
-- existing functions.
-- ─────────────────────────────────────────────────────────────────────

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
begin
  -- Only inbound rows trigger a notification feed entry.
  if new.direction <> 'inbound' then return new; end if;

  -- Skip STOP-keyword inbound (DND signal, not chat).
  if lower(trim(coalesce(new.body, ''))) ~ '^(stop|unsubscribe|quit|end|cancel|opt[ ]?out|stopall)\b' then
    return new;
  end if;

  -- Resolve a human sender label
  if new.contact_id is not null then
    select coalesce(name, phone) into v_contact_name
      from public.contacts where id = new.contact_id;
  end if;
  v_title := coalesce(v_contact_name, new.to_number, 'Unknown number');
  v_body  := substr(coalesce(new.body, '(image)'), 1, 100);

  -- Recipients = admin/user role profiles
  select array_agg(id) into v_admins from public.notification_admin_user_ids() as id;
  if v_admins is null or array_length(v_admins, 1) is null then return new; end if;

  -- Insert one notifications row per admin so the in-app center sees it.
  -- Push delivery is handled by tg_push_notify_inbound_sms — NOT here.
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

  return new;
exception when others then
  raise warning 'tg_notify_inbound_sms (feed-only) failed: %', sqlerrm;
  return new;
end;
$$;

comment on function public.tg_notify_inbound_sms is
  'Populates the in-app notifications feed (used by the notification center / badge counts) for inbound SMS. Push delivery is handled separately by tg_push_notify_inbound_sms; do NOT fire pushes from here.';

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
begin
  -- Skip system + Lauren messages (no notification noise from bots)
  if new.sender_kind in ('system', 'lauren') then return new; end if;

  -- Skip soft-deleted rows (consistent with push trigger)
  if new.deleted_at is not null then return new; end if;

  if new.sender_id is not null then
    select coalesce(display_name, name, 'Team') into v_sender_name
      from public.profiles where id = new.sender_id;
  end if;
  v_title := coalesce(v_sender_name, 'Team chat');
  v_body  := substr(coalesce(new.body, ''), 1, 100);
  if length(v_body) = 0 then return new; end if;

  -- Match the recipient logic used by tg_push_notify_team_message:
  -- prefer thread participants, fall back to all team-role profiles.
  select array_agg(distinct user_id)
    into v_recipients
    from public.team_thread_participants
   where thread_id = new.thread_id
     and user_id is distinct from new.sender_id;

  if v_recipients is null or cardinality(v_recipients) = 0 then
    select array_agg(id)
      into v_recipients
      from public.profiles
     where role in ('admin', 'user', 'va')
       and (new.sender_id is null or id <> new.sender_id);
  end if;

  if v_recipients is null or cardinality(v_recipients) = 0 then
    return new;
  end if;

  -- Populate the feed. Push delivery handled by tg_push_notify_team_message.
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

  return new;
exception when others then
  raise warning 'tg_notify_team_message (feed-only) failed: %', sqlerrm;
  return new;
end;
$$;

comment on function public.tg_notify_team_message is
  'Populates the in-app notifications feed (used by the notification center / badge counts) for team_messages. Push delivery is handled separately by tg_push_notify_team_message (including @mention parsing); do NOT fire pushes from here.';
