-- Append the deal's address column to the inbound-call push notification body.
-- Justin 2026-06-09: 'Is there any way to have the address in that push
-- notification as well, or at least part of it?'
--
-- For surplus deals the name carries the street, the address column carries
-- county/state. For flips the name is the street and the address is city/state.
-- Either way, appending the address column adds meaningful geographic context
-- without overlap. iOS truncates the body gracefully if it overflows.

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
  v_deal_address text;
  v_assigned_to text;
  v_meta jsonb;
  v_title text;
  v_body text;
  v_payload jsonb;
begin
  if new.direction is distinct from 'inbound' then
    return new;
  end if;

  select array_agg(id)
    into v_team_ids
    from public.profiles
   where role in ('admin', 'user', 'va');
  if v_team_ids is null or cardinality(v_team_ids) = 0 then
    return new;
  end if;

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
    select d.name, d.address, d.assigned_to, d.meta
      into v_deal_name, v_deal_address, v_assigned_to, v_meta
      from public.deals d
     where d.id = new.deal_id
     limit 1;
    if (v_assigned_to is null or trim(v_assigned_to) = '') and v_meta is not null then
      v_assigned_to := nullif(trim(v_meta->>'assigned_to'), '');
    end if;
  end if;

  v_title := '📞 ' || v_caller_name;

  if new.deal_id is not null then
    v_body := case when v_assigned_to is not null and v_assigned_to <> ''
                   then 'Assigned to ' || v_assigned_to
                   else 'Unassigned'
              end;
    if v_deal_name is not null and v_deal_name <> '' then
      v_body := v_body || ' · ' || v_deal_name;
    end if;
    if v_deal_address is not null and trim(v_deal_address) <> '' then
      v_body := v_body || ' · ' || trim(v_deal_address);
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

  perform net.http_post(
    url     := v_endpoint,
    body    := v_payload,
    headers := jsonb_build_object('Content-Type', 'application/json')
  );

  return new;
end;
$$;
