-- Push notification trigger for team chat (Justin/Nathan/Eric internal channel).
--
-- Fires when a new team_messages row lands. Targets:
--   - For threads with explicit participants (DMs, lauren_rooms): the
--     participants set minus the sender
--   - For threads with no participants list (open channels like "Ops"):
--     all admin / user / va profiles minus the sender
--
-- Skips:
--   - lauren_dm / lauren_room thread types — those are AI chats, pushing
--     yourself for an AI response would be confusing
--   - sender_kind = 'lauren' — Lauren posting in any thread shouldn't
--     wake the team's phones, that's what the in-app realtime
--     subscription is for
--
-- Hits the send-push-notification Edge Function via pg_net.

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
  -- Skip Lauren's own posts — the team will see them via realtime
  if new.sender_kind = 'lauren' then
    return new;
  end if;

  -- Skip soft-deleted writes
  if new.deleted_at is not null then
    return new;
  end if;

  -- Look up thread type + title
  select thread_type, title
    into v_thread_type, v_thread_title
    from public.team_threads
   where id = new.thread_id;

  -- Don't push for Lauren chat threads — the Lauren tab itself surfaces
  -- those, and waking someone's phone for an AI reply is noise.
  if v_thread_type in ('lauren_dm', 'lauren_room') then
    return new;
  end if;

  -- Recipients = participants minus sender. If no participants exist
  -- (open channel like "Ops"), fan out to all team-role profiles.
  select array_agg(distinct user_id)
    into v_recipient_ids
    from public.team_thread_participants
   where thread_id = new.thread_id
     and user_id is distinct from new.sender_id;

  if v_recipient_ids is null or cardinality(v_recipient_ids) = 0 then
    select array_agg(id)
      into v_recipient_ids
      from public.profiles
     where role in ('admin', 'user', 'va')
       and id is distinct from new.sender_id;
  end if;

  if v_recipient_ids is null or cardinality(v_recipient_ids) = 0 then
    return new;
  end if;

  -- Friendly sender name from profiles
  select coalesce(display_name, name, 'team')
    into v_sender_name
    from public.profiles
   where id = new.sender_id;
  if v_sender_name is null then
    v_sender_name := 'Team';
  end if;

  v_body_preview := substr(coalesce(new.body, ''), 1, 120);

  v_payload := jsonb_build_object(
    'user_ids',  to_jsonb(v_recipient_ids),
    -- Title format: "[# Ops] Nathan" for channels, "Nathan" for DMs.
    -- Keeps the iOS banner scannable.
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

drop trigger if exists tg_push_notify_team_message on public.team_messages;
create trigger tg_push_notify_team_message
  after insert on public.team_messages
  for each row
  execute function public.tg_push_notify_team_message();

comment on function public.tg_push_notify_team_message is
  'Fires a push notification to all team members on the thread when a team_messages row is inserted. '
  'Skips Lauren posts (sender_kind=lauren) and Lauren chat threads (lauren_dm, lauren_room).';
