-- Allow `kind='coach'` on agent_feedback for free-form coaching notes.
-- Per Justin 2026-05-14: merge research_grade + text_draft thumbs into a
-- single "coach" text field. The user types whatever they want — about
-- the message, the lead tier, the contact (deceased, etc), or general
-- training input — and the system stores it.
--
-- Coach notes can be saved with or without a signal — signal is no longer
-- mandatory. The existing thumbs widget remains supported (for the rare
-- surface that still wants binary ratings).

alter table public.agent_feedback
  drop constraint if exists agent_feedback_kind_check;

alter table public.agent_feedback
  add constraint agent_feedback_kind_check
  check (kind in ('text_draft', 'research_grade', 'coach'));

alter table public.agent_feedback
  alter column signal drop not null;

alter table public.agent_feedback
  drop constraint if exists agent_feedback_signal_check;

alter table public.agent_feedback
  add constraint agent_feedback_signal_check
  check (signal is null or signal in ('up', 'down'));

-- Lift the target-present constraint so coach notes don't have to point
-- at an outreach_queue row (they're often just general comments).
alter table public.agent_feedback
  drop constraint if exists agent_feedback_target_present;

alter table public.agent_feedback
  add constraint agent_feedback_target_present
  check (
    (kind = 'text_draft'     and outreach_queue_id is not null) or
    (kind = 'research_grade' and deal_id is not null) or
    (kind = 'coach')
  );
