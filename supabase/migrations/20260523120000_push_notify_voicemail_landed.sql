-- Voicemail-landed push notification.
--
-- Today's gap (caught during 2026-05-23 testing prep): when an inbound
-- call is missed, the team gets ONE push at ring-time ("📞 Incoming: X").
-- The caller is then invited to leave a voicemail by the twilio-voice-status
-- Edge Function's <Record> TwiML. 60-120 seconds later, Twilio fires a
-- standalone recording callback that updates `call_logs.recording_url` —
-- but no follow-up push fires. The team has to actively check the deal
-- to see whether the caller bothered to leave anything.
--
-- This trigger closes the gap: when `recording_url` transitions from NULL
-- to non-NULL on a missed inbound call, fire a distinct push:
--   "🎙 Voicemail from <caller>" + "About: <deal>"
-- with `data.type = 'voicemail'` so mobile can route differently than
-- the live-ring push.
--
-- Why an UPDATE trigger instead of doing this inside the Edge Function:
-- recording_url can also land via Case 1 (ring recording from
-- record-from-ringing-dual) — that's an answered call, not a voicemail.
-- A DB trigger gated on `status='missed' AND direction='inbound'` only
-- fires for actual voicemails, regardless of which Twilio path populated
-- the column.

create or replace function public.tg_push_notify_voicemail_landed()
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
begin
  -- Only fire on transition NULL → non-NULL (don't re-push on subsequent
  -- updates that touch recording_url, e.g. a manual edit).
  if old.recording_url is not null then
    return new;
  end if;
  if new.recording_url is null then
    return new;
  end if;

  -- Only for missed inbound calls — answered calls also populate
  -- recording_url (ring recording) but they don't need a follow-up push.
  if new.direction is distinct from 'inbound' then
    return new;
  end if;
  if new.status is distinct from 'missed' then
    return new;
  end if;

  -- All team members get the banner. Same audience as the live-ring push.
  select array_agg(id)
    into v_team_ids
    from public.profiles
   where role in ('admin', 'user', 'va');
  if v_team_ids is null or cardinality(v_team_ids) = 0 then
    return new;
  end if;

  -- Caller name resolution mirrors tg_push_notify_inbound_call.
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

  -- Deal name for the body line.
  if new.deal_id is not null then
    select coalesce(d.name, d.id)
      into v_deal_name
      from public.deals d
     where d.id = new.deal_id;
  end if;

  v_payload := jsonb_build_object(
    'user_ids', to_jsonb(v_team_ids),
    'title',    '🎙 Voicemail from ' || v_caller_name,
    'body',     case
                  when v_deal_name is not null then 'About: ' || v_deal_name
                  else 'Tap to listen — no deal linked yet'
                end,
    'data', jsonb_build_object(
      'type',        'voicemail',
      'deal_id',     new.deal_id,
      'contact_id',  new.contact_id,
      'call_id',     new.id,
      'from_number', new.from_number,
      'recording_url', new.recording_url
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

drop trigger if exists tg_push_notify_voicemail_landed on public.call_logs;
create trigger tg_push_notify_voicemail_landed
  after update on public.call_logs
  for each row
  when (old.recording_url is null and new.recording_url is not null)
  execute function public.tg_push_notify_voicemail_landed();

comment on function public.tg_push_notify_voicemail_landed is
  'Fires a "🎙 Voicemail from <caller>" push when recording_url first '
  'populates on a missed inbound call. Closes the gap where the only '
  'push was at ring-time, leaving the team unaware the caller actually '
  'left a message. data.type = voicemail so mobile routes distinctly.';
