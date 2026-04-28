-- Fix: Lauren's "Confirm" button errored with
--   "Could not choose the best candidate function between:
--    public.lauren_execute_action(p_action_id => uuid),
--    public.lauren_execute_action(p_action_id => uuid, p_caller_id => uuid)"
--
-- Migration 20260427030800_lauren_capabilities.sql introduced a 2-arg
-- version (p_action_id, p_caller_id default null) but the earlier 1-arg
-- version was never dropped. With p_caller_id defaulted, both signatures
-- match a 1-arg call and Postgres can't tie-break.
--
-- The 2-arg version is canonical (it includes all the action-type
-- branches plus the EF bypass-mode caller-override). Dropping the
-- 1-arg orphan resolves every JSX call (the frontend passes just
-- p_action_id) to the 2-arg version with p_caller_id => null, where
-- coalesce(p_caller_id, auth.uid()) restores the original behavior.

drop function if exists public.lauren_execute_action(uuid);

-- The original 030800 migration accidentally granted execute on the
-- 1-arg signature; re-grant on the 2-arg signature in case Postgres
-- didn't carry the permission across the overload boundary.
grant execute on function public.lauren_execute_action(uuid, uuid) to authenticated;
