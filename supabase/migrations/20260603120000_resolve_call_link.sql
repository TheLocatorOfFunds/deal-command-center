-- resolve_call_link(p_number) — single source of truth for mapping a phone
-- number to (deal_id, contact_id) for call linking.
--
-- Why this exists: every call path (twilio-voice inbound, twilio-voice-outbound
-- SDK, mobile-place-call bridge, twilio-voice-status) re-implemented its own
-- phone match against contacts.phone. The existing find_deal_by_phone() does
--   right(regexp_replace(c.phone,'\D','','g'), 10)
-- which CONCATENATES every digit in the field first. For a contact whose phone
-- column holds several numbers in one string (e.g. Robert Donaghy:
-- "440-749-4336, 440-571-2859, 440-749-7669") that collapses to one 30-digit
-- run and only the LAST number's last-10 can ever match. A call to the first
-- number (4336) matched nothing -> orphaned -> invisible on the deal.
--
-- resolve_call_link splits the phone field on , / ; and matches each number
-- individually, so any of a contact's numbers links the call. Falls back to
-- find_deal_by_phone (homeowner/vendor) for a deal-only match.
--
-- Returns 0 rows when nothing matches (a true orphan -> stays in global Call
-- History but on no deal).

create or replace function public.resolve_call_link(p_number text)
returns table(deal_id text, contact_id uuid)
language sql
security definer
set search_path = public
as $$
  with t as (
    select right(regexp_replace(coalesce(p_number, ''), '\D', '', 'g'), 10) as d10
  )
  select m.deal_id, m.contact_id
  from (
    -- Priority 1: a contact (multi-number CSV aware) that is linked to a deal.
    select cd.deal_id as deal_id, c.id as contact_id, 1 as priority
    from contacts c
    join contact_deals cd on cd.contact_id = c.id
    cross join t
    where length(t.d10) = 10
      and exists (
        select 1
        from regexp_split_to_table(coalesce(c.phone, ''), '[,/;]+') as ph(num)
        where right(regexp_replace(ph.num, '\D', '', 'g'), 10) = t.d10
      )

    union all

    -- Priority 2: homeowner / vendor / legacy match -> deal only (no contact).
    select f.id as deal_id, null::uuid as contact_id, 2 as priority
    from t
    cross join lateral public.find_deal_by_phone('+1' || t.d10, t.d10) as f
    where length(t.d10) = 10
  ) m
  order by m.priority, m.deal_id
  limit 1;
$$;

grant execute on function public.resolve_call_link(text) to service_role;

comment on function public.resolve_call_link(text) is
  'Maps a phone number to (deal_id, contact_id) for call linking. Splits multi-number contact phone fields; falls back to find_deal_by_phone. Used by twilio-voice, twilio-voice-outbound, mobile-place-call, twilio-voice-status.';
