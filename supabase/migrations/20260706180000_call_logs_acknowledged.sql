-- Acknowledge inbound callbacks in the 🔔 bell (Nathan 2026-07-06).
-- The bell's "Replies & callbacks" section shows inbound calls, but call_logs had
-- no "seen" concept — so callbacks just lingered (texts already clear via
-- messages_outbound.read_by_team_at). This adds an ack the ✓ button + "Clear all"
-- stamp, and loadInboundFeed filters acknowledged_at IS NULL.
--
-- NOTE: call_logs grants to 'authenticated' are column-restricted (a specific
-- column list, not table-wide), so new columns need an EXPLICIT grant or the
-- client UPDATE silently updates 0 rows.
alter table public.call_logs add column if not exists acknowledged_at timestamptz;
alter table public.call_logs add column if not exists acknowledged_by uuid;
grant select (acknowledged_at, acknowledged_by), update (acknowledged_at, acknowledged_by)
  on public.call_logs to authenticated;
