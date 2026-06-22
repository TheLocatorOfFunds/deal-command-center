-- 2026-05-10 — Fix notify_ops_chat_on_lauren_alert() silent failure.
--
-- Bug discovered by the (g) smoke test 2026-05-09 PM:
-- The original trigger function (shipped in 20260508180000) declared
-- `v_conv record` and only populated it when NEW.conversation_id was
-- not null. The v_body construction then unconditionally read
-- v_conv.page_origin / v_conv.token / v_conv.message_count, which
-- raises "record 'v_conv' is not assigned yet" when conversation_id
-- is null. The `exception when others then return NEW` catch
-- swallowed the error silently, so the team_messages insert never
-- ran for any lauren_alerts row without a conversation_id.
--
-- Real impact: orphan alerts, keyword hits without conv context, and
-- any flow that didn't pass conversation_id silently failed to post
-- to # Ops. The B claim-alert leg works because its trigger uses
-- scalar variables not record fields.
--
-- Fix: replace v_conv record access with scalar variables
-- (v_page_origin / v_token / v_message_count) that are NULL when the
-- conversation lookup didn't run. The coalesce() chains in v_body
-- handle NULL correctly.
--
-- Also: swap `exception when others then return NEW` to RAISE WARNING
-- + return NEW. Future silent failures will surface in postgres logs
-- with SQLSTATE + SQLERRM instead of disappearing.

create or replace function public.notify_ops_chat_on_lauren_alert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ops_id        uuid;
  v_page_origin   text;
  v_token         text;
  v_message_count int;
  v_body          text;
  v_signal_label  text;
  v_keyword       text;
  v_user_message  text;
begin
  v_ops_id := public.get_ops_thread_id();
  if v_ops_id is null then return NEW; end if;

  -- Pull conversation context into scalars (NULL-safe even if the row
  -- doesn't exist or conversation_id is NULL).
  if NEW.conversation_id is not null then
    select page_origin, token, message_count
      into v_page_origin, v_token, v_message_count
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

  v_keyword      := NEW.meta->>'keyword';
  v_user_message := NEW.meta->>'user_message';

  v_body := v_signal_label || E'\n\n'
    || 'Visitor: ' || coalesce(left(NEW.visitor_id, 12), '?') || E'\n'
    || coalesce('Page: ' || v_page_origin || E'\n', '')
    || coalesce('From URL: /s/' || v_token || E'\n', '')
    || coalesce('Messages: ' || v_message_count::text || E'\n', '')
    || case when v_keyword is not null
            then 'Keyword: "' || v_keyword || '"' || E'\n'
            else '' end
    || case when v_user_message is not null
            then E'\nLast user message: "' || left(v_user_message, 200) || '"'
            else '' end;

  insert into public.team_messages (thread_id, sender_id, sender_kind, body)
  values (v_ops_id, null, 'system', v_body);

  return NEW;
exception when others then
  -- Fail-quiet but loud-in-logs: this trigger MUST NOT break the
  -- parent lauren_alerts insert, but silent swallowing hid this bug
  -- for 2 days. RAISE WARNING surfaces SQLSTATE + SQLERRM in
  -- postgres logs without breaking the flow.
  raise warning '[notify_ops_chat_on_lauren_alert] suppressed error: % %',
    SQLSTATE, SQLERRM;
  return NEW;
end;
$$;

comment on function public.notify_ops_chat_on_lauren_alert() is
  'Posts a system message to # Ops when lauren-event-router records a new alert. NULL-safe on conversation context (scalar vars not record). Errors are caught + logged via RAISE WARNING. Fixed 2026-05-10 after smoke test revealed silent record-access failure on conversation_id=NULL alerts.';
