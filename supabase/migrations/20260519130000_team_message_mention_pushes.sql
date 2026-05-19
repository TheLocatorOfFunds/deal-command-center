-- Team chat @mention push notifications.
--
-- Augments tg_push_notify_team_message() so that when a message body
-- contains `@<word>` tokens that resolve to admin/VA profiles, those
-- users get a distinct "X mentioned you in #thread" push instead of
-- (and not in addition to) the generic thread push. Mentioned users
-- are subtracted from the generic recipient list to prevent double-
-- pinging.
--
-- Mention resolution: case-insensitive prefix-match against
-- profiles.display_name OR profiles.name. Matches the convention used
-- by the web composer (src/app.jsx ~3647 insertMention) and the mobile
-- composer (mobile/app/team-thread/[id].tsx), which both insert
-- `@<label> ` where <label> is display_name || name.
--
-- Limitations:
--   * Single-word names only. `@John Doe` will only match `@John`. All
--     current teammates (Nathan, Justin, Eric, Anam) have single-word
--     display names, so this is fine in practice. Multi-word names
--     would need a stored mentions array on team_messages.
--   * Self-mentions are silently dropped (don't push yourself).
--
-- After this migration ships, every team message goes out as up to two
-- pushes:
--   1. Generic push to recipients minus mentioned users
--   2. Mention push to mentioned users
-- Each push hits send-push-notification with its own user_ids array.

create or replace function public.tg_push_notify_team_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_supabase_url   text := 'https://rcfaashkfpurkvtmsmeb.supabase.co';
  v_endpoint       text;
  v_thread_type    text;
  v_thread_title   text;
  v_recipient_ids  uuid[];
  v_mentioned_ids  uuid[];
  v_generic_ids    uuid[];
  v_sender_name    text;
  v_body_preview   text;
  v_mention_tokens text[];
  v_payload        jsonb;
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

  -- ─── Extract @mention tokens from the body ──────────────────────────
  -- regexp_matches returns one row per match; flatten to a text[] of
  -- distinct lowercase tokens (matches profiles.display_name/name
  -- using ILIKE start-with).
  select array_agg(distinct lower((m.match)[1]))
    into v_mention_tokens
    from regexp_matches(
           coalesce(new.body, ''),
           '(?:^|\s)@(\w+)',
           'g'
         ) as m(match)
   where (m.match)[1] is not null
     and length((m.match)[1]) > 0;

  if v_mention_tokens is not null and cardinality(v_mention_tokens) > 0 then
    -- Resolve tokens to user_ids — case-insensitive starts-with match
    -- against display_name or name. Only consider team-role profiles
    -- that are in the recipient set (so a stray @foo doesn't notify
    -- people outside this thread).
    select array_agg(distinct p.id)
      into v_mentioned_ids
      from public.profiles p
     where p.id = any(v_recipient_ids)
       and exists (
         select 1
           from unnest(v_mention_tokens) as t(tok)
          where p.display_name ilike (t.tok || '%')
             or p.name         ilike (t.tok || '%')
       );
  end if;

  -- Subtract mentioned users from the generic push so they're not
  -- double-pinged. They get the bespoke "X mentioned you" push instead.
  if v_mentioned_ids is not null and cardinality(v_mentioned_ids) > 0 then
    select array_agg(r)
      into v_generic_ids
      from unnest(v_recipient_ids) as r
     where r <> all(v_mentioned_ids);
  else
    v_generic_ids := v_recipient_ids;
  end if;

  v_endpoint := v_supabase_url || '/functions/v1/send-push-notification';

  -- ─── Generic thread push ────────────────────────────────────────────
  if v_generic_ids is not null and cardinality(v_generic_ids) > 0 then
    v_payload := jsonb_build_object(
      'user_ids', to_jsonb(v_generic_ids),
      -- Title format: "[# Ops] Nathan" for channels, "Nathan" for DMs.
      'title', case
                 when v_thread_type = 'channel'
                 then '[# ' || coalesce(v_thread_title, 'team') || '] ' || v_sender_name
                 else v_sender_name
               end,
      'body', v_body_preview,
      'data', jsonb_build_object(
        'type',       'team',
        'thread_id',  new.thread_id,
        'message_id', new.id
      ),
      'sound', 'default'
    );

    perform net.http_post(
      url     := v_endpoint,
      body    := v_payload,
      headers := jsonb_build_object('Content-Type', 'application/json')
    );
  end if;

  -- ─── Mention push (distinct title so the banner reads differently) ──
  if v_mentioned_ids is not null and cardinality(v_mentioned_ids) > 0 then
    v_payload := jsonb_build_object(
      'user_ids', to_jsonb(v_mentioned_ids),
      'title', v_sender_name
               || ' mentioned you'
               || case
                    when v_thread_type = 'channel'
                    then ' in # ' || coalesce(v_thread_title, 'team')
                    else ''
                  end,
      'body', v_body_preview,
      'data', jsonb_build_object(
        'type',       'team_mention',
        'thread_id',  new.thread_id,
        'message_id', new.id
      ),
      'sound', 'default'
    );

    perform net.http_post(
      url     := v_endpoint,
      body    := v_payload,
      headers := jsonb_build_object('Content-Type', 'application/json')
    );
  end if;

  return new;
end;
$$;

comment on function public.tg_push_notify_team_message is
  'Fires push notifications for new team_messages rows. '
  'Splits recipients into mentioned (distinct "X mentioned you" push) and '
  'generic (standard thread push) so mentioned users get a clearer banner '
  'and aren''t double-pinged. Skips Lauren posts and lauren_dm/lauren_room threads.';
