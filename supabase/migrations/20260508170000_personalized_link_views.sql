-- Per-view audit log for personalized_links — distinguish "Richard
-- refreshed 39 times" from "39 distinct viewers" from "team testing
-- inflated the counter."
--
-- Background (2026-05-08): Eric flagged that Richard Mikol's URL had
-- 39 views and "✓ submitted claim" but those signals couldn't be
-- trusted. Investigation found:
--   - The "claim submission" was Nathan's manual portal test (same
--     fake AR phone 4794595671 as the Nathan-Johnson orphan link)
--   - The 39 views were just a counter — no IP, no user-agent, no
--     visitor identity. Could be 1 person × 39 refreshes, 39 people
--     × 1 visit, or any mix.
--
-- This migration adds a per-view audit table the portal handler
-- writes to on every /s/[token] load. Forward-only — won't backfill
-- the 39 views on Richard, but every NEW view from now on lands here
-- with IP + user-agent + referer + (optional) visitor_id.
--
-- The existing personalized_links.view_count + first/last_viewed_at
-- fields stay (UI reads them; don't break the Leads view). New table
-- is additive audit data only.

create table if not exists public.personalized_link_views (
  id          uuid primary key default gen_random_uuid(),
  token       text not null,
  viewed_at   timestamptz not null default now(),
  ip_address  text,
  user_agent  text,
  referer     text,
  visitor_id  text,
  -- Denormalized helper — set by the portal so admin filters can
  -- exclude team-internal views without joining the IP allowlist.
  is_team_view boolean not null default false
);

create index if not exists idx_personalized_link_views_token
  on public.personalized_link_views (token, viewed_at desc);

create index if not exists idx_personalized_link_views_visitor
  on public.personalized_link_views (token, visitor_id, viewed_at desc)
  where visitor_id is not null;

create index if not exists idx_personalized_link_views_external
  on public.personalized_link_views (token, viewed_at desc)
  where is_team_view = false;

alter table public.personalized_link_views enable row level security;

-- Service-role: portal handler writes via service client. Service-role
-- bypasses RLS by default, but the explicit policy is documentation.
drop policy if exists pl_views_service_all on public.personalized_link_views;
create policy pl_views_service_all on public.personalized_link_views
  for all to service_role using (true) with check (true);

-- Admin + VA read.
drop policy if exists pl_views_admin_va_read on public.personalized_link_views;
create policy pl_views_admin_va_read on public.personalized_link_views
  for select to authenticated
  using (public.is_admin() or public.is_va());

comment on table public.personalized_link_views is
  'Per-view audit log for personalized_links. Inserted by refundlocators-next /s/[token] page handler on every load. Distinguishes real engagement from team testing or refresh-spam — view_count alone doesn''t.';

-- Engagement summary view — exposes the metrics that matter without
-- exposing raw IP/user-agent in the UI. Use this from DCC to render
-- a real "engagement" panel on a deal.
create or replace view public.v_personalized_link_engagement as
select
  pl.token,
  pl.deal_id,
  pl.first_name,
  pl.last_name,
  pl.contact_id,
  -- Total views (including team)
  coalesce(stats.total_views, 0) as total_views,
  -- External views — excludes anything tagged is_team_view=true
  coalesce(stats.external_views, 0) as external_views,
  -- Distinct browser fingerprints (IP + user-agent combo) — closest
  -- proxy for "distinct people viewed this" without dedicated visitor IDs.
  coalesce(stats.distinct_external_fingerprints, 0) as distinct_external_fingerprints,
  -- Distinct visitor_ids (only set if portal sends client-side ID)
  coalesce(stats.distinct_visitor_ids, 0) as distinct_visitor_ids,
  stats.first_external_viewed_at,
  stats.last_external_viewed_at,
  coalesce(stats.external_views_last_7d, 0) as external_views_last_7d,
  coalesce(stats.external_views_last_24h, 0) as external_views_last_24h
from public.personalized_links pl
left join (
  select
    token,
    count(*) as total_views,
    count(*) filter (where not is_team_view) as external_views,
    count(distinct (ip_address || '|' || coalesce(user_agent, '')))
      filter (where not is_team_view) as distinct_external_fingerprints,
    count(distinct visitor_id)
      filter (where not is_team_view and visitor_id is not null) as distinct_visitor_ids,
    min(viewed_at) filter (where not is_team_view) as first_external_viewed_at,
    max(viewed_at) filter (where not is_team_view) as last_external_viewed_at,
    count(*) filter (where not is_team_view and viewed_at > now() - interval '7 days') as external_views_last_7d,
    count(*) filter (where not is_team_view and viewed_at > now() - interval '24 hours') as external_views_last_24h
  from public.personalized_link_views
  group by token
) stats on stats.token = pl.token;

grant select on public.v_personalized_link_engagement to authenticated;

comment on view public.v_personalized_link_engagement is
  'Per-personalized-link engagement metrics derived from personalized_link_views. Use this instead of raw view_count to render real engagement signals — distinct fingerprints + external view counts ignore team testing.';
