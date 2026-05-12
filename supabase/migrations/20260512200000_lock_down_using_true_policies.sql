-- 2026-05-12 — Lock down 10 RLS policies that were using(true).
--
-- Discovered during the Kemper Ansel security deep dive (Tier 1 step B,
-- session archive 2026-05-12-kemper-admin-leak.md). The audit found 11
-- policies on the public schema with using(true), which grants the
-- gated action to ANY authenticated user (or anon for SELECT) — regardless
-- of profiles.role.
--
-- The Kemper incident was the ROLE assignment going wrong. RLS protected
-- the deals/contacts/etc. tables via role checks, but THESE 11 tables
-- would have been readable by Kemper as a non-admin client too, because
-- the policies didn't actually check role.
--
-- This migration fixes 10 of them. The 11th — personalized_links
-- "Anon read by token" — needs coordinated portal/site change to use
-- an RPC instead of a direct SELECT, deferred to a follow-up.
--
-- Pattern:
--   - service-role-named policies → using(auth.role() = 'service_role')
--     plus admin escape hatch where needed
--   - team-data tables → using(is_admin() OR is_va())
--   - duplicate wide-open policies that overlap proper scoped ones → DROP
--
-- Note: service_role bypasses RLS entirely in Postgres, so a policy
-- using(auth.role() = 'service_role') is identical to no policy from
-- the EF side. We keep them so admin can debug from the dashboard SQL
-- editor without using the service_role key.

-- ── A. signing_tokens — service_role + admin only ─────────────────────
drop policy if exists signing_tokens_service_role on public.signing_tokens;
create policy signing_tokens_service_role
  on public.signing_tokens
  for all
  using (auth.role() = 'service_role' OR public.is_admin())
  with check (auth.role() = 'service_role' OR public.is_admin());

-- ── B. outreach_queue — admin + va ────────────────────────────────────
drop policy if exists auth_all_outreach_queue on public.outreach_queue;
create policy auth_all_outreach_queue
  on public.outreach_queue
  for all
  using (public.is_admin() OR public.is_va())
  with check (public.is_admin() OR public.is_va());

-- ── C. call_recordings — admin + va ──────────────────────────────────
drop policy if exists auth_all_call_recordings on public.call_recordings;
create policy auth_all_call_recordings
  on public.call_recordings
  for all
  using (public.is_admin() OR public.is_va())
  with check (public.is_admin() OR public.is_va());

-- ── D. docusign_envelopes — drop the wide-open duplicate ─────────────
-- Other policies on this table (docusign_admin_all, docusign_va_read,
-- docusign_va_insert, docusign_client_read, docusign_attorney_read)
-- already cover every legitimate access. The docusign_envelopes_auth_all
-- was a redundant wide-open policy that defeated the others.
drop policy if exists docusign_envelopes_auth_all on public.docusign_envelopes;

-- ── E. messages_outbound_unmatched — admin + va ──────────────────────
drop policy if exists auth_all_unmatched on public.messages_outbound_unmatched;
create policy auth_all_unmatched
  on public.messages_outbound_unmatched
  for all
  using (public.is_admin() OR public.is_va())
  with check (public.is_admin() OR public.is_va());

-- ── F. team_communications — admin + va ──────────────────────────────
drop policy if exists auth_all on public.team_communications;
create policy auth_all
  on public.team_communications
  for all
  using (public.is_admin() OR public.is_va())
  with check (public.is_admin() OR public.is_va());

-- ── G. message_groups — admin + va ───────────────────────────────────
drop policy if exists auth_all_message_groups on public.message_groups;
create policy auth_all_message_groups
  on public.message_groups
  for all
  using (public.is_admin() OR public.is_va())
  with check (public.is_admin() OR public.is_va());

-- ── H. thread_hidden — admin + va ────────────────────────────────────
-- Schema is (deal_id, thread_key, hidden_at) — no user_id. It's a
-- per-deal hidden-thread tracking that the team shares.
drop policy if exists auth_all_thread_hidden on public.thread_hidden;
create policy auth_all_thread_hidden
  on public.thread_hidden
  for all
  using (public.is_admin() OR public.is_va())
  with check (public.is_admin() OR public.is_va());

-- ── I. lauren_alerts — service_role + admin only ─────────────────────
drop policy if exists lauren_alerts_service_role_all on public.lauren_alerts;
create policy lauren_alerts_service_role_all
  on public.lauren_alerts
  for all
  using (auth.role() = 'service_role' OR public.is_admin())
  with check (auth.role() = 'service_role' OR public.is_admin());

-- ── J. lauren_rate_limit — service_role only ─────────────────────────
drop policy if exists lauren_rate_limit_service_role_all on public.lauren_rate_limit;
create policy lauren_rate_limit_service_role_all
  on public.lauren_rate_limit
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- ── K. personalized_link_views — service_role only ───────────────────
-- pl_views_admin_va_read already covers admin/va SELECT separately;
-- this policy is the catch-all for service-role writes (inserts from
-- the portal page's SSR + Edge Functions).
drop policy if exists pl_views_service_all on public.personalized_link_views;
create policy pl_views_service_all
  on public.personalized_link_views
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- ── Verify ────────────────────────────────────────────────────────
-- After running, this should return 0 rows (no more using(true)
-- policies on the previously-vulnerable tables).
select
  c.relname as table_name,
  p.polname as policy_name,
  pg_get_expr(p.polqual, p.polrelid) as still_using_true
from pg_policy p
join pg_class c on c.oid = p.polrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in (
    'signing_tokens', 'outreach_queue', 'call_recordings',
    'docusign_envelopes', 'messages_outbound_unmatched',
    'team_communications', 'message_groups', 'thread_hidden',
    'lauren_alerts', 'lauren_rate_limit', 'personalized_link_views'
  )
  and pg_get_expr(p.polqual, p.polrelid) = 'true'
order by c.relname;
