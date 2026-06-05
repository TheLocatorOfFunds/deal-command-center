-- Backfill for Bug 1 (2026-06-05): receive-sms Edge Function had been inserting
-- inbound Twilio SMS rows with from_number and to_number swapped since the file
-- was first written. The swap was deliberate ("so the UI thread filter works")
-- but obsolete -- thread grouping now uses thread_key, and every downstream
-- consumer that reads `direction === 'inbound' ? from_number : to_number` to
-- identify the other party (mobile thread destinationPhone, web Comms list, etc)
-- has been showing OUR own outbound number as the "sender" for 6 weeks. Most
-- visibly: Nathan opened Todd Kime's deal today, the thread resolver took the
-- swapped from_number (5440) as the destination, and three replies routed back
-- to ourselves with Twilio rejecting "'To' and 'From' number cannot be the same".
--
-- The code fix landed in supabase/functions/receive-sms/index.ts (deployed
-- 2026-06-05). This migration un-swaps the 44 historical rows. Scope:
--   - 44 inbound rows where from_number IN (5440, 2306) -- impossible if the
--     columns weren't swapped, since those are OUR sender lines, not contact
--     phones.
--   - 8 deals affected (surplus-mo03tar7gdct, surplus-moae92eckadd, sf-er,
--     sf-jennings-moa9iqzt, flip-mnz65vx22y21, sf-sizemore,
--     surplus-mo03wykmmg6w, surplus-moho5wwcnkn2) + 5 unmatched-pool rows.
--   - iMessage inbound via mac_bridge was NEVER affected (only Twilio SMS).
--
-- Safety:
--   - Only updates rows that match the swap signature
--     (direction='inbound' AND from_number IN active sender lines).
--     A correctly-stored inbound row would have from_number = contact's number,
--     which can never appear in phone_numbers.
--   - Captures the row IDs in a temp table FIRST, then swaps using those
--     IDs explicitly so we can verify the count and have a rollback list.
--   - Transactional. If anything misbehaves, ROLLBACK.

begin;

-- 1. Snapshot the affected rows BEFORE any change, for evidence + rollback list.
create temp table _inbound_swap_targets on commit drop as
select id, from_number as bad_from, to_number as bad_to, deal_id, created_at
from public.messages_outbound
where direction = 'inbound'
  and from_number in (select number from public.phone_numbers where active);

-- Expect 44 rows as of 2026-06-05 17:46 ET. If this assertion fails, abort.
do $$
declare
  n bigint;
begin
  select count(*) into n from _inbound_swap_targets;
  if n = 0 then
    raise exception 'no rows found to backfill (expected ~44). Did the EF un-swap fix already land + receive-sms drain all the bad rows?';
  end if;
  if n > 200 then
    raise exception 'safety guard: % rows would be touched (>200 is unexpected). Investigate before re-running.', n;
  end if;
  raise notice 'backfilling % swapped inbound rows', n;
end $$;

-- 2. Swap from_number <-> to_number on exactly those rows.
update public.messages_outbound m
   set from_number = t.bad_to,
       to_number   = t.bad_from
  from _inbound_swap_targets t
 where m.id = t.id;

-- 3. Verify: 0 inbound rows should now have from_number = our sender line.
do $$
declare
  remaining bigint;
begin
  select count(*) into remaining
    from public.messages_outbound
   where direction = 'inbound'
     and from_number in (select number from public.phone_numbers where active);
  if remaining > 0 then
    raise exception 'post-swap audit: % inbound rows still have from_number = our sender line. Rolling back.', remaining;
  end if;
  raise notice 'post-swap audit: 0 polluted rows remain';
end $$;

commit;
