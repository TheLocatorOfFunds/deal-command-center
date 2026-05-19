-- Fire a push notification to the team when an inbound call rings the
-- Twilio number. The phone-ringing UX itself stays on the browser
-- (Twilio.Device <Client>) and/or Nathan's iPhone forwarding for now —
-- this trigger adds the *deal context* to every team member's phone
-- simultaneously, so they can see who's calling about which case
-- before deciding to answer.
--
-- Phase 1 (Expo Go): banner notification only. Tap → opens the deal.
-- Phase 2 (EAS dev build + Twilio Voice SDK + react-native-callkeep):
--   we'll register a mobile Twilio.Device identity and ring the phone
--   directly, but the push payload format here stays the same.

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
  -- Only ringing inbound calls. Outbound and status updates are skipped.
  if new.direction is distinct from 'inbound' then
    return new;
  end if;
  if new.status is distinct from 'ringing' then
    return new;
  end if;

  -- All team members (admin / user / va) get the banner.
  select array_agg(id)
    into v_team_ids
    from public.profiles
   where role in ('admin', 'user', 'va');
  if v_team_ids is null or cardinality(v_team_ids) = 0 then
    return new;
  end if;

  -- Caller name: prefer contacts.name, fall back to "(unknown caller)"
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

  -- Deal name to put in the body
  if new.deal_id is not null then
    select coalesce(d.name, d.id)
      into v_deal_name
      from public.deals d
     where d.id = new.deal_id;
  end if;

  -- "📞 Calling: Randy Amos" — title goes in the iOS banner header,
  -- body gives the deal context.
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

drop trigger if exists tg_push_notify_inbound_call on public.call_logs;
create trigger tg_push_notify_inbound_call
  after insert on public.call_logs
  for each row
  execute function public.tg_push_notify_inbound_call();

comment on function public.tg_push_notify_inbound_call is
  'Fires a push notification to all team members when an inbound call '
  'rings the Twilio number. Resolves the caller name from contacts and '
  'the deal name from deals; banner shows "📞 Incoming: <name>" with '
  '"About: <deal>" as the body. Tap routes to /deal/{deal_id}.';
