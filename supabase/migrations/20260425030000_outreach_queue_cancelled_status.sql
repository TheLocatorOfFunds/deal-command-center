-- Add 'cancelled' to outreach_queue.status check constraint.
--
-- Justin's original outreach_queue table allowed: queued | generating |
-- pending | sent | skipped | failed. 'cancelled' was missing, which broke
-- the STOP-keyword DND handler in receive-sms (added 2026-04-25 by Nathan's
-- session — it tries to cancel pending rows when a contact opts out of SMS).
--
-- Discovered during the Monday-launch smoke test 2026-04-25:
-- 1946c93a-e255-4ede-b4f4-b9d2309dfeac was supposed to flip queued→cancelled
-- on STOP receipt; the update silently failed inside receive-sms's try/catch.
--
-- 'cancelled' is semantically distinct from 'skipped':
--   - skipped = human-driven (Nathan clicked Skip on the draft)
--   - cancelled = system-driven (DND opt-out, deal closed, etc.)
--
-- dispatch-cadence-message also writes 'cancelled' when it re-checks DND
-- right before firing send-sms.

alter table public.outreach_queue drop constraint if exists outreach_queue_status_check;
alter table public.outreach_queue add constraint outreach_queue_status_check
  check (status in ('queued', 'generating', 'pending', 'sent', 'skipped', 'failed', 'cancelled'));
