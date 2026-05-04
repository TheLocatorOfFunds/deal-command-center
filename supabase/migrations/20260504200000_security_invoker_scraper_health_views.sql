-- Switch scraper-health views from SECURITY DEFINER to SECURITY INVOKER.
--
-- Supabase Advisor (2026-05-04) flagged both views as CRITICAL — a view
-- that runs with DEFINER (the view owner's) privileges silently bypasses
-- RLS for any caller, which can leak data past per-role policies.
--
-- These views (scraper_health, v_scraper_health) only aggregate from
-- public.scrape_runs + public.scraper_agents — both of which have RLS
-- that already allows admin / VA reads. So switching to INVOKER means
-- admins keep seeing everything and the views stop being a privilege-
-- elevation surface.
--
-- Postgres 15+ supports `security_invoker = on` directly on the view.
-- Supabase runs PG 15+.

alter view public.scraper_health    set (security_invoker = on);
alter view public.v_scraper_health  set (security_invoker = on);
