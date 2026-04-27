-- Allow admin + VA to update messages_outbound (specifically read_by_team_at).
--
-- Symptom: clicking "Mark seen" on a Reply Inbox row silently failed.
-- The PATCH returned 200 OK with an empty `[]` body — RLS allowed SELECT
-- (so the row showed in the inbox) but the UPDATE policy filtered the
-- row out of update scope, dropping it to a 0-row update with no error.
--
-- Fix: explicit admin_va update policy that mirrors the same trust model
-- used elsewhere on messages_outbound for SELECT + INSERT.

drop policy if exists messages_outbound_admin_va_update on public.messages_outbound;
create policy messages_outbound_admin_va_update on public.messages_outbound
  for update to authenticated
  using (public.is_admin() or public.is_va())
  with check (public.is_admin() or public.is_va());
