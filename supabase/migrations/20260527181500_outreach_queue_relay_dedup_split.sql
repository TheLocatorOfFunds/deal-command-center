-- Phase A.1 — resolve the cadence_day collision between Relay and Automations
--
-- Both engines write to public.outreach_queue. Automations uses cadence_day
-- as a fixed ladder (0/1/3/5/12...90). Relay overloads cadence_day with the
-- sequence step_number (1-7). The existing unique index
-- idx_outreach_queue_no_dup_active on (deal_id, cadence_day) WHERE status in
-- (queued,generating,pending) treated both as one namespace — so a Relay
-- step N and an Automations day N for the SAME deal collided and the Relay
-- insert failed silently (relay-dispatcher logged "outreach_queue insert
-- failed"). That's part of why Relay rows piled up unsent.
--
-- Fix: scope the cadence-day dedup to NON-relay (Automations) rows only, and
-- give Relay rows their own dedup keyed on (relay_enrollment_id,
-- relay_step_number). Relay's sequences own who/what/when; Automations keeps
-- its ladder dedup. The two no longer fight over the cadence_day key.
--
-- Verified before writing: 0 existing duplicate (relay_enrollment_id,
-- relay_step_number) pairs among active rows, so the new unique index applies
-- cleanly. The Automations subset (relay_enrollment_id IS NULL) was already
-- unique under the old index, so the narrowed index also applies cleanly.

-- 1. Narrow the existing Automations dedup to non-relay rows.
drop index if exists public.idx_outreach_queue_no_dup_active;

create unique index if not exists idx_outreach_queue_no_dup_active
  on public.outreach_queue (deal_id, cadence_day)
  where status in ('queued', 'generating', 'pending')
    and relay_enrollment_id is null;

-- 2. Relay rows dedup on their own enrollment+step identity.
create unique index if not exists idx_outreach_queue_no_dup_relay
  on public.outreach_queue (relay_enrollment_id, relay_step_number)
  where status in ('queued', 'generating', 'pending')
    and relay_enrollment_id is not null;
