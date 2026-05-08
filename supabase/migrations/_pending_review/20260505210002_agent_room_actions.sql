-- Agent-room Phase 1 — dispatch decision audit.
--
-- Source-of-truth brief: ~/Documents/Claude/agent-room/CLAUDE.md
-- Migration spec: ~/Documents/Claude/agent-room/docs/MIGRATIONS_FOR_DCC.md §1
--
-- Agent-room is a Python daemon on defender-mini that acts as a
-- subordinate worker to Lauren (the senior AI — memory:
-- project_lauren_senior_ai). Lauren holds the conversation; ops_agent
-- runs DB writes / edge-fn calls / shell commands she dispatches and
-- posts a one-line receipt.
--
-- Phase 1 = passive observer (shadow). Daemon evaluates each new
-- team_messages row, asks Claude what ops_agent WOULD have been
-- dispatched to do, logs the decision here with status='shadow'.
-- Never posts to team_messages.
--
-- Phase 2 (active receipts): also adds 'ops_agent' to the
-- team_messages.sender_kind constraint, creates the ops-agent auth
-- user, and the rate-limit table — but those are all separate
-- migrations applied at Phase-2 cutover, not here.

create table if not exists public.agent_room_actions (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid references public.team_threads(id) on delete cascade,
  triggered_by_message_id uuid references public.team_messages(id),
  agent_kind text not null default 'ops_agent',
  action_type text not null check (action_type in (
    'db_read',
    'db_write',
    'edge_fn',
    'shell',
    'reply',
    'defer',
    'awaiting_confirm'
  )),
  action_payload jsonb default '{}'::jsonb,
  result jsonb default '{}'::jsonb,
  status text not null default 'shadow' check (status in (
    'shadow',
    'success',
    'failed',
    'awaiting_confirm',
    'skipped_cost_cap'
  )),
  error_message text,
  reasoning text,
  duration_ms int,
  created_at timestamptz not null default now()
);

create index if not exists agent_room_actions_thread_created
  on public.agent_room_actions (thread_id, created_at desc);

create index if not exists agent_room_actions_status
  on public.agent_room_actions (status);

create index if not exists agent_room_actions_action_type
  on public.agent_room_actions (action_type);

-- RLS: service-role write (the daemon), team-read (admin only).
alter table public.agent_room_actions enable row level security;

drop policy if exists agent_room_actions_service_all on public.agent_room_actions;
create policy agent_room_actions_service_all on public.agent_room_actions
  for all to service_role using (true) with check (true);

drop policy if exists agent_room_actions_admin_read on public.agent_room_actions;
create policy agent_room_actions_admin_read on public.agent_room_actions
  for select to authenticated
  using (public.is_admin());

comment on table public.agent_room_actions is
  'Audit log for the ops_agent daemon. Every dispatch decision lands here regardless of outcome. Phase 1 always logs status=''shadow'' (no real actions taken).';

comment on column public.agent_room_actions.triggered_by_message_id is
  'The team_messages row that triggered evaluation. NULL only if the daemon decided to act outside a chat trigger (Phase 4 watcher mode).';

comment on column public.agent_room_actions.reasoning is
  'One-sentence explanation from the dispatch decider. Useful for debugging false-positives in the trigger model during shadow tuning.';
