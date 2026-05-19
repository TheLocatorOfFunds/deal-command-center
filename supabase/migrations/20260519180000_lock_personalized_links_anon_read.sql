-- 2026-05-19 — Lock down personalized_links: drop the anon-read leak.
--
-- The last open finding from the Tier 1B RLS audit (2026-05-12). Was
-- deferred at the time because I believed the Vercel portal at
-- refundlocators.com/s/{token} relied on it. Re-checked today:
-- every read path in refundlocators-next uses getServiceClient()
-- (service-role key), which bypasses RLS entirely. The
-- "Anon read by token using(true)" policy was completely dead code —
-- but it exposed the entire personalized_links table to anyone with
-- the public anon key.
--
-- Verified before this migration (2026-05-19): anon dump returned
-- 183 rows of homeowner PII — names, phones, addresses, case
-- numbers, surplus estimates.
--
-- Verified portal + DCC paths after this migration:
--   - Portal reads (page.tsx, opengraph-image.tsx, api/s/*, api/admin/leads/*)
--     all use SUPABASE_SERVICE_ROLE_KEY via getServiceClient() → bypass RLS
--   - DCC reads (src/app.jsx lines 8307-9213) run as admin-role JWT
--     and hit admin_all_personalized_links policy
--   - Castle / refundlocators-pipeline writes use service-role key
--
-- Adds team_read_personalized_links so VAs working in DCC keep their
-- read access (admin_all_personalized_links was admin-only).

drop policy if exists "Anon read by token" on public.personalized_links;

create policy team_read_personalized_links
  on public.personalized_links
  for select
  using (public.is_admin() OR public.is_va());

-- Verify (should return 0 — no using(true) policies left)
select c.relname, p.polname, pg_get_expr(p.polqual, p.polrelid) as using_clause
from pg_policy p
join pg_class c on c.oid = p.polrelid
where c.relname = 'personalized_links'
  and pg_get_expr(p.polqual, p.polrelid) = 'true';
