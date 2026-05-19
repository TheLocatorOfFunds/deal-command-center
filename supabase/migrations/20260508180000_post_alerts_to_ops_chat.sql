-- 2026-05-08 — Route claim submissions + Lauren alerts to # Ops team chat.
--
-- Per Nathan: SMS + email notification paths are silently failable
-- (today's audit found Castle health alerts have email_sent=false 5
-- days running, and the claim alert chain has never been verified end
-- -to-end). Adding a third notification leg that posts directly into
-- the # Ops team_messages thread means the team sees alerts even if
-- Twilio + Resend silently fail. Realtime broadcast on team_messages
-- ensures every open DCC client sees the message within seconds.
--
-- Two paths covered:
--   1. personalized_links.claim_submitted_at flips NULL → NOT NULL
--      → post claim summary to # Ops
--   2. lauren_alerts row inserted (router already decided alert-worthy)
--      → post Lauren alert summary to # Ops
--
-- Implementation: new SQL triggers that fire alongside the existing
-- pg_net.http_post triggers. SMS + email keep firing too — this is
-- additive. No Edge Function redeploy required.

-- ── A) Allow 'system' as a sender_kind on team_messages ───────────
alter table public.team_messages
  drop constraint if exists team_messages_sender_kind_check;
alter table public.team_messages
  add constraint team_messages_sender_kind_check
  check (sender_kind in ('admin', 'va', 'lauren', 'system'));

-- ── B) Helper: get the Ops thread id, NULL if missing ─────────────
create or replace function public.get_ops_thread_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.team_threads
  where title = 'Ops'
    and archived_at is null
  order by created_at
  limit 1;
$$;

comment on function public.get_ops_thread_id() is
  'Returns the # Ops team_threads.id (NULL if missing or archived). Looked up by title because Ops is the seed-created channel and never gets re-created. Used by the system-alert triggers below.';

-- ── C) Trigger function: claim submission → # Ops post ────────────
create or replace function public.notify_ops_chat_on_claim_submitted()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ops_id uuid;
  v_deal_name text;
  v_full_name text;
  v_surplus_label text;
  v_body text;
begin
  -- Only fire on the transition from NULL → NOT NULL (first-time submission).
  if NEW.claim_submitted_at is null then return NEW; end if;
  if OLD.claim_submitted_at is not null then return NEW; end if;

  v_ops_id := public.get_ops_thread_id();
  if v_ops_id is null then return NEW; end if;

  v_full_name := trim(both ' ' from coalesce(NEW.first_name, '') || ' ' || coalesce(NEW.last_name, ''));
  if v_full_name = '' then v_full_name := 'Unknown'; end if;

  v_surplus_label := case
    when NEW.estimated_surplus_low is not null and NEW.estimated_surplus_high is not null
      then '$' || to_char(NEW.estimated_surplus_low, 'FM999G999G999')
           || '–$' || to_char(NEW.estimated_surplus_high, 'FM999G999G999')
    when NEW.estimated_surplus_low is not null
      then '$' || to_char(NEW.estimated_surplus_low, 'FM999G999G999') || '+'
    else null
  end;

  if NEW.deal_id is not null then
    select name into v_deal_name from public.deals where id = NEW.deal_id;
  end if;

  v_body := '🎯 PERSONALIZED CLAIM SUBMITTED' || E'\n\n'
    || 'Name: ' || v_full_name || E'\n'
    || coalesce('Phone: ' || NEW.phone || E'\n', '')
    || coalesce('Property: ' || NEW.property_address || E'\n', '')
    || coalesce('Mailing: ' || NEW.mailing_address || E'\n', '')
    || coalesce('County: ' || NEW.county || E'\n', '')
    || coalesce('Case #: ' || NEW.case_number || E'\n', '')
    || coalesce('Est. surplus: ' || v_surplus_label || E'\n', '')
    || coalesce('Source: ' || NEW.source || E'\n', '')
    || E'\n'
    || case
         when NEW.deal_id is not null then
           'Deal: ' || coalesce(v_deal_name, NEW.deal_id) || E'\n'
           || 'Open: https://app.refundlocators.com/#/deal/' || NEW.deal_id || '/overview'
         else
           'Orphan link — no deal yet (token: ' || NEW.token || ')'
       end;

  insert into public.team_messages (thread_id, sender_id, sender_kind, body)
  values (v_ops_id, null, 'system', v_body);

  return NEW;
exception when others then
  -- Fail-quiet: chat post must never break the claim flow.
  return NEW;
end;
$$;

drop trigger if exists tg_notify_ops_chat_on_claim_submitted on public.personalized_links;
create trigger tg_notify_ops_chat_on_claim_submitted
  after update of claim_submitted_at on public.personalized_links
  for each row
  execute function public.notify_ops_chat_on_claim_submitted();

comment on function public.notify_ops_chat_on_claim_submitted() is
  'Posts a system message to the # Ops team_messages thread when a homeowner submits the /s/[token] claim form (claim_submitted_at flips NULL→NOT NULL). Runs alongside the existing notify-claim-submitted Edge Function trigger; this leg is independent so SMS/email outages don''t mask the alert.';

-- ── D) Trigger function: Lauren alert → # Ops post ────────────────
create or replace function public.notify_ops_chat_on_lauren_alert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ops_id uuid;
  v_conv record;
  v_body text;
  v_signal_label text;
  v_keyword text;
  v_user_message text;
begin
  v_ops_id := public.get_ops_thread_id();
  if v_ops_id is null then return NEW; end if;

  if NEW.conversation_id is not null then
    select id, started_at, message_count, token, page_origin, ip
      into v_conv
    from public.lauren_conversations
    where id = NEW.conversation_id;
  end if;

  v_signal_label := case NEW.signal_type
    when 'claim_submitted'    then '🎯 Lauren chat → CLAIM SUBMITTED'
    when 'token_chat_started' then '💬 Personalized URL recipient started chatting Lauren'
    when 'engaged_chat'       then '💬 5+ message Lauren chat in progress'
    when 'keyword_hit'        then '🚨 Lauren chat — keyword flagged'
    else                           '💬 Lauren alert: ' || NEW.signal_type
  end;

  v_keyword := NEW.meta->>'keyword';
  v_user_message := NEW.meta->>'user_message';

  v_body := v_signal_label || E'\n\n'
    || 'Visitor: ' || coalesce(left(NEW.visitor_id, 12), '?') || E'\n'
    || coalesce('Page: ' || v_conv.page_origin || E'\n', '')
    || coalesce('From URL: /s/' || v_conv.token || E'\n', '')
    || coalesce('Messages: ' || v_conv.message_count::text || E'\n', '')
    || case when v_keyword is not null then 'Keyword: "' || v_keyword || '"' || E'\n' else '' end
    || case when v_user_message is not null then E'\nLast user message: "' || left(v_user_message, 200) || '"' else '' end;

  insert into public.team_messages (thread_id, sender_id, sender_kind, body)
  values (v_ops_id, null, 'system', v_body);

  return NEW;
exception when others then
  return NEW;
end;
$$;

drop trigger if exists tg_notify_ops_chat_on_lauren_alert on public.lauren_alerts;
create trigger tg_notify_ops_chat_on_lauren_alert
  after insert on public.lauren_alerts
  for each row
  execute function public.notify_ops_chat_on_lauren_alert();

comment on function public.notify_ops_chat_on_lauren_alert() is
  'Posts a system message to # Ops when lauren-event-router records a new alert (any signal_type). Piggybacks on the router''s existing decision logic — if it didn''t insert a row, nothing posts.';

-- ── E) Verify ────────────────────────────────────────────────────
select
  (select id from public.team_threads where title = 'Ops' and archived_at is null limit 1) as ops_thread_id,
  exists (select 1 from pg_proc where proname = 'notify_ops_chat_on_claim_submitted') as claim_fn_exists,
  exists (select 1 from pg_proc where proname = 'notify_ops_chat_on_lauren_alert') as lauren_fn_exists,
  exists (select 1 from pg_trigger where tgname = 'tg_notify_ops_chat_on_claim_submitted') as claim_trigger_attached,
  exists (select 1 from pg_trigger where tgname = 'tg_notify_ops_chat_on_lauren_alert') as lauren_trigger_attached,
  (select count(*) from team_messages where sender_kind = 'system') as system_messages_now;
