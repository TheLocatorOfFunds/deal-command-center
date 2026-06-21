-- Review Queue (Nathan 2026-06-21): surface every "ready for outreach" surplus lead
-- that has a gap or a "funds may be gone" signal, so Eric/Inaam verify + decide.
-- DETERMINISTIC flags only — the system never decides; it surfaces. A lead leaves
-- the queue when the gap is fixed (phone added, heir linked, amount filled, lead
-- dispositioned) or a human stamps meta.review_cleared_at via the "Reviewed" button.
-- security_invoker = respects the caller's RLS on deals (no new SECURITY DEFINER view).
create or replace view public.v_lead_review_queue
with (security_invoker = on) as
with base as (
  select d.id, d.name, d.status, d.meta,
    coalesce(
      case when (d.meta->>'verifiedSurplus')  ~ '^-?\d+(\.\d+)?$' then (d.meta->>'verifiedSurplus')::numeric  end,
      case when (d.meta->>'estimatedSurplus') ~ '^-?\d+(\.\d+)?$' then (d.meta->>'estimatedSurplus')::numeric end, 0) as surplus_amt,
    coalesce(
      nullif(trim(d.meta->>'homeownerPhone'),''), nullif(trim(d.meta->>'phone'),''),
      nullif(trim(d.meta->>'contactPhone'),''),  nullif(trim(d.meta->>'ownerPhone'),''),
      (select nullif(trim(c.phone),'') from contact_deals cd join contacts c on c.id=cd.contact_id
         where cd.deal_id=d.id and nullif(trim(c.phone),'') is not null limit 1)
    ) as any_phone,
    (case when d.deceased=false then false when d.deceased=true then true
          when (d.meta->>'deceased')='false' then false
          else coalesce(d.death_signal,false) or (d.meta->>'deceased') in ('true','t','1') end) as v_deceased,
    exists(select 1 from contact_deals cd join contacts c on c.id=cd.contact_id
           where cd.deal_id=d.id and nullif(trim(c.phone),'') is not null
             and lower(coalesce(cd.relationship,'')) <> 'homeowner') as heir_phone,
    regexp_replace(coalesce(d.meta->'case_intel_summary'->>'text',''), E'[\n\r]+',' ','g') as ai_text,
    (d.meta->'case_intel_summary'->>'generated_at') as ai_at,
    count(*) over (partition by lower(trim(d.name))) as name_dupes
  from deals d
  where d.prepped_at is not null and d.deleted_at is null and d.type='surplus'
    and (d.meta->>'review_cleared_at') is null
),
flagged as (
  select *,
    case
      when status in ('dead','dismissed') or (meta->>'case_dismissed')='true' then 'dead_but_ready'
      when ai_text ~* '(already (been )?(claimed|distributed|disbursed|paid out)|distributed to|funds (have been |were )?(released|disbursed|distributed)|deal is dead|legally dead|no surplus exists|\$0 (available|coming|to))' then 'verify_maybe_gone'
      when v_deceased and not heir_phone then 'deceased_no_heir'
      when any_phone is null then 'no_phone'
      when surplus_amt <= 0 then 'no_surplus_amount'
      when name_dupes > 1 then 'possible_duplicate'
      else null
    end as flag
  from base
)
select
  id as deal_id, name, round(surplus_amt)::bigint as surplus,
  case when flag='verify_maybe_gone' then 'verify_available' else 'not_callable' end as category,
  case flag
    when 'dead_but_ready'     then 'Marked DEAD/dismissed but still in the ready pile — confirm and remove'
    when 'verify_maybe_gone'  then 'AI brief flags the surplus may already be distributed — verify the docket before calling'
    when 'deceased_no_heir'   then 'Homeowner deceased, no heir/relative contact to call — find an heir or skip-trace'
    when 'no_phone'           then 'No phone number on file — add a number before it can be called'
    when 'no_surplus_amount'  then 'No surplus $ recorded — likely pre-sale, or the amount needs filling in'
    when 'possible_duplicate' then 'Same homeowner name appears more than once in the ready pile — check for a duplicate'
  end as reason,
  flag,
  case when flag='verify_maybe_gone' then left(ai_text, 320) else null end as evidence,
  ai_at,
  case flag when 'verify_maybe_gone' then 1 when 'dead_but_ready' then 2 when 'deceased_no_heir' then 3
            when 'no_phone' then 4 when 'possible_duplicate' then 5 when 'no_surplus_amount' then 6 end as priority
from flagged
where flag is not null;

grant select on public.v_lead_review_queue to anon, authenticated;
