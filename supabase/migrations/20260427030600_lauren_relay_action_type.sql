-- Allow 'relay_to_user' as a valid lauren_pending_actions.action_type.
--
-- The Phase 3 migration locked the check constraint to three values:
-- ('update_deal_status','create_task','update_deal_meta'). The Hub-mode
-- migration (20260427030500) extended the lauren_execute_action handler
-- to support 'relay_to_user' but didn't widen the check constraint, so
-- inserts via propose_relay_to_teammate fail with a check violation —
-- visible in the FAB as "The relay tool is hitting a database
-- constraint error" when the user asks Lauren to loop a teammate in.

alter table public.lauren_pending_actions
  drop constraint if exists lauren_pending_actions_action_type_check;

alter table public.lauren_pending_actions
  add constraint lauren_pending_actions_action_type_check
  check (action_type in (
    'update_deal_status',
    'create_task',
    'update_deal_meta',
    'relay_to_user'
  ));
