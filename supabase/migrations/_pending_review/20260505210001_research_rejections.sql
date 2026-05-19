-- Research-agent — durable rejection audit log.
--
-- Source-of-truth brief: ~/Documents/Claude/fundlocators-research-agent/CLAUDE.md
-- Migration spec: ~/Documents/Claude/fundlocators-research-agent/docs/MIGRATIONS_FOR_DCC.md §1
--
-- Every lead the research agent rejects lands here with a structured
-- reason. Lets Nathan run `select reason_code, count(*) from
-- research_rejections group by 1 order by 2 desc` later and decide if
-- any rejection class is too aggressive.
--
-- Phase 1 (shadow): rejected leads only land here (NOT in deals).
-- Phase 2 (active): same — rejections never touch DCC's deals table.
--
-- Per memory project_ohio_intel_verified_surplus_leg, the status
-- taxonomy is still_claimable / claim_in_progress / already_claimed /
-- unverified — denied-motion intervenors map to already_claimed.
--
-- Per memory feedback_surplus_20k_floor (updated 2026-05-05):
-- verified surplus → ≥$5k, unverified → ≥$20k.

create table if not exists public.research_rejections (
  id uuid primary key default gen_random_uuid(),
  case_number text not null,
  county text not null,
  rejected_at timestamptz not null default now(),
  reason_code text not null check (reason_code in (
    'already_claimed',
    'medicaid_lien_drains_surplus',
    'bankruptcy_filed',
    'multiple_conflicting_heirs',
    'judgment_paid_pre_sale',
    'sale_rescinded',
    'owner_deceased_no_estate',
    'non_person_owner',
    'surplus_below_threshold',
    'tier_demoted_below_c',
    'external_api_unavailable'
  )),
  reason_detail text,
  evidence jsonb default '{}'::jsonb,
  would_have_been_tier text check (would_have_been_tier in ('A', 'B', 'C')),
  ohio_intel_thought_tier text check (ohio_intel_thought_tier in ('A', 'B', 'C')),
  scrape_run_id text,
  agent_run_id uuid,
  created_at timestamptz default now()
);

create unique index if not exists research_rejections_case_county_unique
  on public.research_rejections (case_number, county);

create index if not exists research_rejections_reason_code
  on public.research_rejections (reason_code);

create index if not exists research_rejections_rejected_at
  on public.research_rejections (rejected_at desc);

-- RLS: service-role write, team-read (admin only).
alter table public.research_rejections enable row level security;

drop policy if exists research_rejections_service_all on public.research_rejections;
create policy research_rejections_service_all on public.research_rejections
  for all to service_role using (true) with check (true);

drop policy if exists research_rejections_admin_read on public.research_rejections;
create policy research_rejections_admin_read on public.research_rejections
  for select to authenticated
  using (public.is_admin());

comment on table public.research_rejections is
  'Durable audit of leads the research agent rejected. Never touches deals. Survives a tuning pass — kept for ''select reason_code, count(*) group by 1'' analysis.';
