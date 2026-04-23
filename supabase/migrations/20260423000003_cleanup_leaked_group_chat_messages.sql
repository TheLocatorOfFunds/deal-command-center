-- Cleanup: remove personal group-chat messages that leaked into DCC deals.
--
-- How they got there:
--   1. mac-bridge synced Nathan's entire chat.db including personal group chats
--   2. tg_route_message_to_deal auto-stamped them with deal_id when a participant's
--      phone matched any contact, vendor, or homeowner in DCC
--   3. The SMS tab pulled them in via a cross-deal phone fallback query
--
-- All three layers are now fixed (bridge group filter, trigger guard, UI cleanup).
-- This migration removes the rows already in prod.
--
-- Safe to identify leaked rows because:
--   - All bridge-synced rows have twilio_sid LIKE 'imsg_%' (set by bridge.js)
--   - Tapbacks have body matching 'Liked "…"', 'Loved "…"', etc.
--   - Justin's personal cell +14797196859 is not a DCC business contact

-- 1. Delete tapback reactions (Liked/Loved/etc.) on any deal, bridge-sourced only.
--    These are never useful business messages and are an artefact of the leak.
delete from public.messages_outbound
where twilio_sid like 'imsg_%'
  and (
    body like 'Liked "%'
    or body like 'Loved "%'
    or body like 'Laughed at "%'
    or body like 'Emphasized "%'
    or body like 'Disliked "%'
    or body like 'Questioned "%'
  );

-- 2. Delete all bridge-synced messages involving Justin's personal cell
--    (+14797196859 / 4797196859) — that number is not a DCC deal contact.
delete from public.messages_outbound
where twilio_sid like 'imsg_%'
  and (
    right(regexp_replace(to_number,   '\D', '', 'g'), 10) = '4797196859'
    or right(regexp_replace(from_number, '\D', '', 'g'), 10) = '4797196859'
  );

-- 3. Mark remaining bridge rows as channel='imessage' so the trigger guard
--    retroactively covers any future re-upsert attempts.
update public.messages_outbound
set channel = 'imessage'
where twilio_sid like 'imsg_%'
  and channel != 'imessage';

-- Verify: show what's left on the affected deal
-- select id, to_number, from_number, body, created_at
-- from messages_outbound
-- where deal_id = 'surplus-moae92eckadd' and twilio_sid like 'imsg_%'
-- order by created_at;
