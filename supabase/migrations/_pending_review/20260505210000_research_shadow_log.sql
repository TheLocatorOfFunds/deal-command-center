-- Research-agent Phase 1 — shadow mode log.
--
-- Source-of-truth brief: ~/Documents/Claude/fundlocators-research-agent/CLAUDE.md
-- Migration spec: ~/Documents/Claude/fundlocators-research-agent/docs/MIGRATIONS_FOR_DCC.md §2
--
-- The research agent (a NEW lane Nathan owns, separate from DCC and
-- Castle) sits between Ohio-intel and DCC. Phase 1 runs the agent in
-- shadow mode — it never writes to deals/contacts/documents; it logs
-- the decision it WOULD have made into this table. We then compare
-- those decisions against Eric's actual prep work for ~50 leads and
-- tune the trigger model before flipping to canary.
--
-- Per memory project_surplus_pdf_storage_decision (2026-05-01): Ohio
-- Intel shares DCC's Supabase rather than running its own. So this
-- table physically lives in DCC's Postgres but DCC's UI doesn't render
-- it. Only the research agent + Ohio Intel touch it.
--
-- Drop after Phase 3 if not useful.

create table if not exists public.research_shadow_log (
  id uuid primary key default gen_random_uuid(),
  case_number text not null,
  county text not null,
  decision text not null check (decision in ('approve', 'reject', 'needs_human_review')),
  confidence numeric(3, 2),
  tier_initial text check (tier_initial in ('A', 'B', 'C')),
  tier_confirmed text check (tier_confirmed in ('A', 'B', 'C')),
  rejection_reason_codes text[],
  reasoning text,
  enrichments jsonb default '{}'::jsonb,
  apis_called jsonb default '{}'::jsonb,
  elapsed_ms integer,
  agent_version text,
  scrape_run_id text,
  human_decision text,
  human_decision_at timestamptz,
  human_decision_notes text,
  created_at timestamptz not null default now()
);

create unique index if not exists research_shadow_log_case_county_unique
  on public.research_shadow_log (case_number, county);

create index if not exists research_shadow_log_decision
  on public.research_shadow_log (decision);

create index if not exists research_shadow_log_created_at
  on public.research_shadow_log (created_at desc);

-- RLS: service-role write (research agent), team-read (Nathan + Justin
-- can SELECT for tuning). Other roles blocked.
alter table public.research_shadow_log enable row level security;

drop policy if exists research_shadow_log_service_all on public.research_shadow_log;
create policy research_shadow_log_service_all on public.research_shadow_log
  for all to service_role using (true) with check (true);

drop policy if exists research_shadow_log_admin_read on public.research_shadow_log;
create policy research_shadow_log_admin_read on public.research_shadow_log
  for select to authenticated
  using (public.is_admin());

comment on table public.research_shadow_log is
  'Phase-1 shadow log for the research-agent middleware. Each row is one decision the agent WOULD have made on an Ohio-intel lead. Compare against Eric''s manual prep work to tune the trigger model.';

comment on column public.research_shadow_log.human_decision is
  'Filled in later by Eric/Nathan during review — the decision a human actually made on the same lead. Lets us measure agent agreement.';
