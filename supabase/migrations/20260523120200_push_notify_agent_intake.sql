-- Agent-intake push notification.
--
-- Fires when the Vapi voice agent finishes a call and the vapi-webhook
-- EF writes the structured intake to call_logs.voice_intake. Distinct
-- from:
--   - tg_push_notify_inbound_call (rings push at call-start)
--   - tg_push_notify_voicemail_landed (voicemail-recording-ready push)
--
-- The point of THIS push: surface the structured intake summary right
-- on the lock-screen so the team can decide "call back now" vs "queue
-- for later" without opening the app. The data.type='agent_intake'
-- lets mobile route the tap to a future intake-detail surface if/when
-- we build one (today the tap can just route to the deal).

create or replace function public.tg_push_notify_agent_intake()
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
  v_topic text;
  v_urgency text;
  v_deal_name text;
  v_body text;
  v_payload jsonb;
begin
  -- Only fire on transition NULL → non-NULL.
  if old.voice_intake is not null then
    return new;
  end if;
  if new.voice_intake is null then
    return new;
  end if;

  -- All team members get the banner.
  select array_agg(id)
    into v_team_ids
    from public.profiles
   where role in ('admin', 'user', 'va');
  if v_team_ids is null or cardinality(v_team_ids) = 0 then
    return new;
  end if;

  -- Pull what we can from the structured intake. Field names match the
  -- JSON Schema we configure on the Vapi assistant — keep them in sync.
  v_caller_name := coalesce(
    new.voice_intake->>'caller_name',
    (select coalesce(c.name, c.company) from public.contacts c where c.id = new.contact_id limit 1),
    new.from_number,
    'Unknown caller'
  );
  v_topic := coalesce(
    new.voice_intake->>'case_reference',
    new.voice_intake->>'county',
    new.voice_intake->>'notes'
  );
  v_urgency := new.voice_intake->>'urgency';

  if new.deal_id is not null then
    select coalesce(d.name, d.id)
      into v_deal_name
      from public.deals d
     where d.id = new.deal_id;
  end if;

  -- Body line — prioritize what's most useful at a glance:
  -- urgency > topic > deal name > fallback
  v_body := case
              when v_urgency is not null and v_topic is not null
                then v_urgency || ' · ' || v_topic
              when v_urgency is not null then v_urgency
              when v_topic is not null then v_topic
              when v_deal_name is not null then 'About: ' || v_deal_name
              else 'Tap to review the intake'
            end;
  -- Trim to keep the banner scannable
  v_body := substr(v_body, 1, 120);

  v_payload := jsonb_build_object(
    'user_ids', to_jsonb(v_team_ids),
    'title',    '🤖 Agent intake: ' || v_caller_name,
    'body',     v_body,
    'data', jsonb_build_object(
      'type',        'agent_intake',
      'deal_id',     new.deal_id,
      'contact_id',  new.contact_id,
      'call_id',     new.id,
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

drop trigger if exists tg_push_notify_agent_intake on public.call_logs;
create trigger tg_push_notify_agent_intake
  after update on public.call_logs
  for each row
  when (old.voice_intake is null and new.voice_intake is not null)
  execute function public.tg_push_notify_agent_intake();

comment on function public.tg_push_notify_agent_intake is
  'Fires "🤖 Agent intake: <caller>" push when Vapi (or any future '
  'voice-agent provider) writes structured intake to call_logs.voice_intake. '
  'data.type = agent_intake so mobile can route distinctly from inbound_call / voicemail pushes.';
