-- Fire a push notification to all team members (admin / user roles) when
-- an inbound SMS lands in messages_outbound. We hit the
-- send-push-notification Edge Function via pg_net, which then dispatches
-- to each team member's registered Expo push token (set on
-- profiles.expo_push_token by the mobile app).
--
-- Why a DB trigger instead of inline in receive-sms: messages_outbound
-- also catches iMessages from the Mac bridge daemon, which writes
-- directly without going through the Twilio receive-sms function. A
-- trigger catches both paths.
--
-- Stay quiet during the morning sweep / system-routed messages by gating
-- on direction='inbound' explicitly.

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
  v_title text;
  v_body_preview text;
  v_payload jsonb;
begin
  -- Only inbound matters
  if new.direction is distinct from 'inbound' then
    return new;
  end if;

  -- Pull all team-side recipients (admin OR legacy 'user' role). We
  -- broadcast — the right person to respond is whoever sees it first.
  select array_agg(id)
    into v_team_ids
    from public.profiles
   where role in ('admin', 'user');
  if v_team_ids is null or cardinality(v_team_ids) = 0 then
    return new;
  end if;

  -- Try to resolve a friendly sender name from contacts. Fall back to
  -- the bare phone number.
  select coalesce(c.name, c.company)
    into v_sender_name
    from public.contacts c
   where c.id = new.contact_id
   limit 1;
  if v_sender_name is null then
    select coalesce(c.name, c.company)
      into v_sender_name
      from public.contacts c
     where c.phone = new.from_number
        or c.phone = regexp_replace(new.from_number, '^\+1', '')
     limit 1;
  end if;
  if v_sender_name is null then
    v_sender_name := new.from_number;
  end if;

  -- 80-char preview keeps the body readable in the iOS notification banner.
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

  -- Fire-and-forget — pg_net returns immediately, the function call
  -- happens async. If push delivery fails, we log nothing here; the
  -- Edge Function logs its own errors.
  perform net.http_post(
    url     := v_endpoint,
    body    := v_payload,
    headers := jsonb_build_object('Content-Type', 'application/json')
  );

  return new;
end;
$$;

drop trigger if exists tg_push_notify_inbound_sms on public.messages_outbound;
create trigger tg_push_notify_inbound_sms
  after insert on public.messages_outbound
  for each row
  execute function public.tg_push_notify_inbound_sms();

comment on function public.tg_push_notify_inbound_sms is
  'Fires a push notification to all team members when an inbound SMS lands. '
  'Both Twilio (receive-sms Edge Function) and the Mac bridge daemon write '
  'to messages_outbound, so trigger-based dispatch catches both paths.';
