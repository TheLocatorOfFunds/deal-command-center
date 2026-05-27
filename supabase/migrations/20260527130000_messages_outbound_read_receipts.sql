-- ─────────────────────────────────────────────────────────────────────
-- 20260527130000_messages_outbound_read_receipts
--
-- Phase 5 (D1) of the 5/27 comms redesign: iMessage delivery + read
-- receipts. The Mac bridge already polls chat.db for outbound delivery;
-- this adds the columns it writes read/delivered timestamps into, plus the
-- chat.db ROWID so the bridge can re-poll a specific message's date_read.
--
--   imessage_rowid  — chat.db message.ROWID for this outbound row, captured
--                     by the bridge at send time. Lets the read-receipt
--                     poller re-query date_delivered / date_read by ROWID.
--   delivered_at    — when iMessage reported the message delivered.
--   read_at         — when the recipient read it (only populated if they
--                     have read receipts enabled; SMS-over-Twilio never sets
--                     this — carrier limitation).
--
-- NOTE: read_at here is the RECIPIENT's read state (iMessage). It is NOT
-- read_by_team_at, which tracks whether OUR team has seen an INBOUND reply.
-- Different direction, different meaning — don't conflate them.
-- ─────────────────────────────────────────────────────────────────────

alter table public.messages_outbound
  add column if not exists imessage_rowid  bigint,
  add column if not exists delivered_at    timestamptz,
  add column if not exists read_at         timestamptz;

comment on column public.messages_outbound.imessage_rowid is
  'chat.db message.ROWID for this outbound iMessage, captured by the Mac bridge at send time. Used to re-poll read/delivered status.';
comment on column public.messages_outbound.delivered_at is
  'When iMessage reported delivery (bridge reads chat.db message.date_delivered).';
comment on column public.messages_outbound.read_at is
  'When the RECIPIENT read the message (iMessage read receipt, if enabled). Distinct from read_by_team_at (our team seeing an inbound reply).';
