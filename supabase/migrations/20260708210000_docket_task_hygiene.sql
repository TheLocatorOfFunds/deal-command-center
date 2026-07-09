-- Docket-task hygiene: stop the docket automation from polluting the Tasks tab.
--
-- Problem (found 2026-07-08): 337 open tasks, every single one spawned by
-- handle_docket_auto_task() and bulk-assigned to 'Nathan'. An April 2026
-- Castle backfill arrived WITHOUT raw.backfill=true, so the is_backfill
-- guard never fired and tasks were created for hearings as old as 2005
-- (e.g. "Hearing 2022-11-30 - prep client", due 2022-11-28). My Day (#333)
-- had to work around the pollution with a tight due-date-window heuristic.
--
-- Three parts:
--   1. Trigger: skip historical events by DATE (event_date >30 days old),
--      not just by the is_backfill flag. Backfills demonstrably arrive
--      unflagged; an event that happened a month ago is not a live action
--      item no matter what the flag says. Also: never create a hearing-prep
--      task for a hearing that already happened, and clamp due_date so a
--      task is never born overdue.
--   2. Trigger: assigned_to NULL instead of 'Nathan'. Task views render
--      unassigned tasks fine (checked web src/app.jsx, mobile, and
--      get_daily_worklist - none require assignment). My Day "Waiting on
--      you" filters assigned_to='Nathan', so auto-tasks stop counting as
--      founder-blocked work until a human deliberately assigns them.
--   3. Data: close open docket-spawned tasks due before 2026-06-03
--      (>35 days past due as of 2026-07-08) - a hearing can't be prepped
--      after it happened. Fixed literal cutoff so this migration is
--      deterministic on replay. One team-visible activity row per touched
--      deal, batched in a single statement.

-- ── 1 + 2. Recreate the trigger function ──────────────────────────────

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
  if coalesce(NEW.is_backfill, false) then return NEW; end if;

  -- Historical events that arrive WITHOUT the backfill flag (the April 2026
  -- incident): anything that happened >30 days ago is dead on arrival.
  if NEW.event_date is not null and NEW.event_date < current_date - 30 then
    return NEW;
  end if;

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
      -- A hearing that already happened can't be prepped
      if NEW.event_date is not null and NEW.event_date < current_date then
        return NEW;
      end if;
      task_title := '📅 Hearing ' || coalesce(NEW.event_date::text, 'TBD') || ' — prep client';
      -- Due two days before the hearing, but never already-overdue at birth
      task_due := greatest(
        coalesce(NEW.event_date - interval '2 days', current_date + interval '3 days')::date,
        current_date
      );
    else
      -- Informational-only event_types (order_entered, motion_filed, answer_filed,
      -- continuance_granted, hearing_continued, docket_updated) don't auto-task.
      return NEW;
  end case;

  -- Unassigned by default: these are team action items, not Nathan's
  -- personal queue. Assignment is now a deliberate human act.
  insert into public.tasks (deal_id, title, due_date, assigned_to, priority)
  values (NEW.deal_id, task_title, task_due, null, task_priority);

  return NEW;
end;
$$;

comment on function public.handle_docket_auto_task() is
  'Spawns an UNASSIGNED task when Castle posts high-signal docket event_types (disbursement_ordered/paid, hearing_scheduled, judgment_entered, objection_filed, notice_of_claim). Skips is_backfill rows AND any event older than 30 days (backfills arrive unflagged - April 2026 incident), skips hearings already past, and never creates a task that is overdue at creation.';

-- ── 3. Close dead docket-spawned tasks + log per-deal activity ─────────

with dead as (
  update public.tasks
     set done = true
   where not done
     and due_date < date '2026-06-03'
     and (
       title like '📅 Hearing %'
       or title like '💰 Disbursement paid%'
       or title like '🔔 Funds ordered%'
       or title like '⚖️ Judgment entered%'
       or title like '⚠️ Objection filed%'
       or title like '👥 Competing claim%'
     )
  returning deal_id
)
insert into public.activity (deal_id, user_id, action, visibility)
select deal_id,
       null,
       '🧹 Auto-closed ' || count(*) || ' stale docket task'
         || case when count(*) = 1 then '' else 's' end
         || ' (due before 2026-06-03; the hearing/disbursement date already passed) - Apr 2026 backfill cleanup',
       array['team']
  from dead
 group by deal_id;
