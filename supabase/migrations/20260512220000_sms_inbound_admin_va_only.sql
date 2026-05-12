-- 2026-05-12 — Lock down sms_inbound_select to admin+va only.
--
-- Found during Tier 1D pen-test of the Kemper security deep dive
-- (session archive 2026-05-12-kemper-admin-leak.md). The policy was:
--
--   USING (direction = 'inbound')
--
-- which meant: ANY authenticated user could read EVERY inbound SMS row.
-- The Tier 1B audit checked for using(true) policies but didn't flag
-- this one because the using clause LOOKED like it was scoping by
-- column — but the column predicate `direction='inbound'` has nothing
-- to do with the calling user's identity or role.
--
-- Pen-test discovered this with a brand-new test client account (no
-- contact_deals link, no admin role): 63 rows returned where 0
-- expected. Fix: AND the role check in.
--
-- Clients access their own deal's inbound messages via the public
-- `messages` table (RLS-scoped via client_access). They don't need
-- access to messages_outbound directly.

drop policy if exists sms_inbound_select on public.messages_outbound;
create policy sms_inbound_select
  on public.messages_outbound
  for select
  using (
    direction = 'inbound'
    AND (public.is_admin() OR public.is_va())
  );

-- Verify (should return 0 rows if applied correctly)
select c.relname, p.polname, pg_get_expr(p.polqual, p.polrelid) as using_clause
from pg_policy p
join pg_class c on c.oid = p.polrelid
where c.relname = 'messages_outbound'
  and p.polname = 'sms_inbound_select'
  and pg_get_expr(p.polqual, p.polrelid) not like '%is_admin%';
