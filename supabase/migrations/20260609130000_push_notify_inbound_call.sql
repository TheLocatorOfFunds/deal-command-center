-- Fire a push notification to all team members (admin / user / va) when an
-- inbound call_logs row lands. The CallKit native UI does not expose any
-- hook to set localizedCallerName from our JS code (Twilio's SDK reports the
-- call to CallKit natively with the SIP From field), so the assignee +
-- deal context goes through a SEPARATE Expo push notification that arrives
-- on the device alongside the CallKit ring.
--
-- Justin 2026-06-09: 'the push notification that it sends just adds who the
-- deal is assigned to.'
--
-- Mirrors tg_push_notify_inbound_sms verbatim, swapped for inbound calls.

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
  v_assigned_to text;
  v_meta jsonb;
  v_title text;
  v_body text;
  v_payload jsonb;
begin
  -- Only inbound, only at insert (the EF inserts in 'ringing' state). Subsequent
  -- status updates (in-progress, completed, missed) do NOT re-fire.
  if new.direction is distinct from 'inbound' then
    return new;
  end if;

  -- Pull all team-side recipients. Same scoping as the assignee dropdowns
  -- (admin / user / va).
  select array_agg(id)
    into v_team_ids
    from public.profiles
   where role in ('admin', 'user', 'va');
  if v_team_ids is null or cardinality(v_team_ids) = 0 then
    return new;
  end if;

  -- Resolve caller name: prefer contacts.name, fall back to from_number.
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

  -- Resolve deal name + assignee. Same precedence as the Leads filter and
  -- the twilio-voice EF: assigned_to column first, meta.assigned_to second.
  if new.deal_id is not null then
    select d.name, d.assigned_to, d.meta
      into v_deal_name, v_assigned_to, v_meta
      from public.deals d
     where d.id = new.deal_id
     limit 1;
    if (v_assigned_to is null or trim(v_assigned_to) = '') and v_meta is not null then
      v_assigned_to := nullif(trim(v_meta->>'assigned_to'), '');
    end if;
  end if;

  v_title := '📞 ' || v_caller_name;

  -- Body composition:
  --   matched deal + assignee: "Assigned to Justin · Beitko Surplus"
  --   matched deal, no assignee: "Unassigned · Beitko Surplus"
  --   no matched deal: "Unmatched caller" (Justin can still answer)
  if new.deal_id is not null then
    v_body := coalesce(
      case when v_assigned_to is not null and v_assigned_to <> ''
           then 'Assigned to ' || v_assigned_to
           else 'Unassigned'
      end,
      'Unassigned'
    );
    if v_deal_name is not null and v_deal_name <> '' then
      v_body := v_body || ' · ' || v_deal_name;
    end if;
  else
    v_body := 'Unmatched caller';
  end if;

  v_payload := jsonb_build_object(
    'user_ids', to_jsonb(v_team_ids),
    'title',    v_title,
    'body',     v_body,
    'data', jsonb_build_object(
      'type',     'call',
      'call_id',  new.id,
      'deal_id',  new.deal_id,
      'contact_id', new.contact_id,
      'call_sid', new.twilio_call_sid
    ),
    'sound', 'default'
  );

  v_endpoint := v_supabase_url || '/functions/v1/send-push-notification';

  -- Fire-and-forget via pg_net. Same pattern as the inbound-SMS notification:
  -- if push delivery fails the EF logs it, the trigger doesn't block the call.
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
  'Fires an Expo push notification with caller name + assignee + deal name '
  'when an inbound call_logs row is inserted. Mirrors tg_push_notify_inbound_sms. '
  'Exists because CallKit''s native UI cannot be customized from JS in our '
  'managed Expo workflow; the separate push delivers the deal context that '
  'the lock-screen ring cannot.';
