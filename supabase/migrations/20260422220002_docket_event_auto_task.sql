-- Auto-task from docket events.
-- When Castle posts certain event_types (disbursement_ordered, hearing_scheduled,
-- etc.) we spawn a task on the deal so Nathan sees a clear action item in the
-- global Tasks view + deal detail. Backfill events are skipped (Casey Jennings
-- alone would spawn 20+ tasks from historical rows). The activity row is
-- redundant with the docket event itself — the unified timeline already shows
-- both — so the trigger writes to tasks only.

create or replace function public.handle_docket_auto_task()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  task_title text;
  task_priority text := 'normal';
  task_due date := current_date;
begin
  -- Backfill events are historical; no action needed
  if NEW.is_backfill then return NEW; end if;

  case NEW.event_type
    when 'disbursement_ordered' then
      task_title := '🔔 Funds ordered on ' || coalesce(NEW.event_date::text, 'unknown date')
                    || ' — call client + ring the bell';
      task_priority := 'high';
    when 'disbursement_paid' then
      task_title := '💰 Disbursement paid — confirm deposit, update client';
      task_priority := 'high';
    when 'judgment_entered' then
      task_title := '⚖️ Judgment entered — review + notify client';
      task_priority := 'high';
    when 'objection_filed' then
      task_title := '⚠️ Objection filed — review with counsel ASAP';
      task_priority := 'high';
    when 'notice_of_claim' then
      task_title := '👥 Competing claim filed — assess + flag';
      task_priority := 'high';
    when 'hearing_scheduled' then
      task_title := '📅 Hearing ' || coalesce(NEW.event_date::text, 'TBD') || ' — prep client';
      -- Due two days before the hearing so there's lead time
      task_due := coalesce(NEW.event_date - interval '2 days', current_date + interval '3 days')::date;
    else
      -- Informational-only event_types (order_entered, motion_filed, answer_filed,
      -- continuance_granted, hearing_continued, docket_updated) don't auto-task.
      return NEW;
  end case;

  insert into public.tasks (deal_id, title, due_date, assigned_to, priority)
  values (NEW.deal_id, task_title, task_due, 'Nathan', task_priority);

  return NEW;
end;
$$;

drop trigger if exists tg_docket_event_auto_task on public.docket_events;
create trigger tg_docket_event_auto_task
  after insert on public.docket_events
  for each row
  execute function public.handle_docket_auto_task();

comment on function public.handle_docket_auto_task() is
  'Spawns a task on the deal when Castle posts high-signal docket event_types (disbursement_ordered, hearing_scheduled, judgment_entered, objection_filed, notice_of_claim). Skips is_backfill rows so historical ingestion doesn''t spam the Tasks view.';
