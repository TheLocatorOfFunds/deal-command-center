-- agent_feedback — training-loop capture for text drafts AND research grading
--
-- Per Justin + Nathan meeting 2026-05-13:
-- Both Lauren's draft texts AND the research agent's tier/grade calls need
-- a feedback mechanism so we can train them over time. The "agent" half of
-- the name keeps this generic enough that future agents (calling, research,
-- whatever) can write to the same table by adding a new `kind` value.
--
-- Two `kind`s on day one:
--   - 'text_draft'   → human review of an outreach_queue AI draft.
--                       outreach_queue_id is required.
--   - 'research_grade' → human correction of a deal's lead_tier or
--                       research call (e.g. "should be B because deceased").
--                       outreach_queue_id is null.
--
-- `signal` is up/down for binary thumbs reaction.
-- `reason` is the user's prose explanation (free text).
-- `suggested_correction` is what they think it SHOULD have been (e.g. a
--   rewritten draft text, or 'B', or 'deeper_research').
-- `context` snapshots whatever was on screen at the time (the actual draft
--   text the user reacted to, the lead_tier at that moment, meta fields,
--   etc.) so we have a reproducible training pair later.

create table if not exists public.agent_feedback (
  id                  uuid primary key default gen_random_uuid(),
  kind                text not null check (kind in ('text_draft', 'research_grade')),
  deal_id             text references public.deals(id) on delete cascade,
  outreach_queue_id   uuid references public.outreach_queue(id) on delete set null,
  user_id             uuid references auth.users(id) on delete set null,
  signal              text not null check (signal in ('up', 'down')),
  reason              text,
  suggested_correction text,
  context             jsonb,
  created_at          timestamptz not null default now()
);

-- text_draft rows must point at the queue row they reacted to.
-- research_grade rows must point at a deal (no queue row required).
alter table public.agent_feedback
  add constraint agent_feedback_target_present
  check (
    (kind = 'text_draft'     and outreach_queue_id is not null) or
    (kind = 'research_grade' and deal_id is not null)
  );

create index if not exists agent_feedback_deal_id_idx
  on public.agent_feedback (deal_id, created_at desc);

create index if not exists agent_feedback_kind_idx
  on public.agent_feedback (kind, created_at desc);

create index if not exists agent_feedback_outreach_queue_id_idx
  on public.agent_feedback (outreach_queue_id)
  where outreach_queue_id is not null;

-- RLS — admins and VAs can read + write. Clients + attorneys never see this.
alter table public.agent_feedback enable row level security;

create policy "admin_va_select_agent_feedback"
  on public.agent_feedback for select
  using (public.is_admin() or public.is_va());

create policy "admin_va_insert_agent_feedback"
  on public.agent_feedback for insert
  with check (
    (public.is_admin() or public.is_va())
    and (user_id is null or user_id = auth.uid())
  );

create policy "admin_va_update_own_agent_feedback"
  on public.agent_feedback for update
  using (
    (public.is_admin() or public.is_va())
    and user_id = auth.uid()
  );

create policy "admin_delete_agent_feedback"
  on public.agent_feedback for delete
  using (public.is_admin());

grant select, insert, update on public.agent_feedback to authenticated;

-- Surface to Realtime so the future feedback dashboard can stream in
-- new rows without polling. Idempotent — guard against re-add.
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'agent_feedback'
  ) then
    alter publication supabase_realtime add table public.agent_feedback;
  end if;
end $$;
