-- Manual "Send to Review" (Nathan 2026-06-23): let the team hand-pick a lead
-- into the Review queue, not just the auto-rules. Sets meta.manual_review; the
-- view surfaces it as a top-priority flag even if the lead isn't auto-flagged
-- (and even if not yet prepped). "Mark reviewed" clears it. Applied to prod via
-- MCP apply_migration. (Supersedes 20260622120200_review_queue_tighten…)
create or replace view public.v_lead_review_queue
with (security_invoker=on) as
with base as (
  select d.id, d.name, d.status, d.meta,
    coalesce(
      case when (d.meta ->> 'verifiedSurplus') ~ '^-?\d+(\.\d+)?$' then (d.meta ->> 'verifiedSurplus')::numeric else null::numeric end,
      case when (d.meta ->> 'estimatedSurplus') ~ '^-?\d+(\.\d+)?$' then (d.meta ->> 'estimatedSurplus')::numeric else null::numeric end,
      0::numeric) as surplus_amt,
    coalesce(nullif(trim(both from d.meta ->> 'homeownerPhone'), ''), nullif(trim(both from d.meta ->> 'phone'), ''), nullif(trim(both from d.meta ->> 'contactPhone'), ''), nullif(trim(both from d.meta ->> 'ownerPhone'), ''),
      (select nullif(trim(both from c.phone), '') from contact_deals cd join contacts c on c.id = cd.contact_id where cd.deal_id = d.id and nullif(trim(both from c.phone), '') is not null limit 1)) as any_phone,
    case when d.deceased = false then false when d.deceased = true then true when (d.meta ->> 'deceased') = 'false' then false else coalesce(d.death_signal, false) or ((d.meta ->> 'deceased') = any (array['true','t','1'])) end as v_deceased,
    (exists (select 1 from contact_deals cd join contacts c on c.id = cd.contact_id where cd.deal_id = d.id and nullif(trim(both from c.phone), '') is not null and lower(coalesce(cd.relationship, '')) <> 'homeowner')) as heir_phone,
    regexp_replace(coalesce((d.meta -> 'case_intel_summary') ->> 'text', ''), '[\n\r]+', ' ', 'g') as ai_text,
    (d.meta -> 'case_intel_summary') ->> 'generated_at' as ai_at,
    count(*) over (partition by (lower(trim(both from d.name)))) as name_dupes
  from deals d
  where (d.prepped_at is not null or d.meta ? 'manual_review')
    and d.deleted_at is null and d.type = 'surplus' and (d.meta ->> 'review_cleared_at') is null
), flagged as (
  select base.*,
    case
      when base.meta ? 'manual_review' then 'manual_review'
      when (base.status = any (array['dead','dismissed'])) or (base.meta ->> 'case_dismissed') = 'true' then 'dead_but_ready'
      when base.ai_text ~* '(deal is dead|legally dead|no (surplus|excess|funds?) (exist|remain|left|available)|nothing (left|remaining) to (claim|recover)|\$0 (surplus|available|remaining|to (claim|recover))|(surplus|excess funds?|excess) (was|were|has been|have been|already)( already)? (claimed|distributed|disbursed|paid out|released|recovered)|already been (claimed|recovered) by|surplus (is|was|already) (gone|claimed|paid))' then 'verify_maybe_gone'
      when base.v_deceased and not base.heir_phone then 'deceased_no_heir'
      when base.any_phone is null then 'no_phone'
      when base.surplus_amt <= 0 then 'no_surplus_amount'
      when base.name_dupes > 1 then 'possible_duplicate'
      else null
    end as flag
  from base
)
select id as deal_id, name, round(surplus_amt)::bigint as surplus,
  case when flag in ('verify_maybe_gone','manual_review') then 'verify_available' else 'not_callable' end as category,
  case flag
    when 'manual_review' then coalesce(meta->'manual_review'->>'reason', 'Flagged for a second look by the team')
    when 'dead_but_ready' then 'Marked DEAD/dismissed but still in the ready pile — confirm and remove'
    when 'verify_maybe_gone' then 'AI brief flags the surplus may already be distributed — verify the docket before calling'
    when 'deceased_no_heir' then 'Homeowner deceased, no heir/relative contact to call — find an heir or skip-trace'
    when 'no_phone' then 'No phone number on file — add a number before it can be called'
    when 'no_surplus_amount' then 'No surplus $ recorded — likely pre-sale, or the amount needs filling in'
    when 'possible_duplicate' then 'Same homeowner name appears more than once in the ready pile — check for a duplicate'
    else null
  end as reason,
  flag,
  case when flag = 'verify_maybe_gone' then left(ai_text, 320) else null end as evidence,
  ai_at,
  case flag
    when 'manual_review' then 0
    when 'verify_maybe_gone' then 1 when 'dead_but_ready' then 2 when 'deceased_no_heir' then 3
    when 'no_phone' then 4 when 'possible_duplicate' then 5 when 'no_surplus_amount' then 6 else null
  end as priority
from flagged
where flag is not null;

create or replace function public.flag_lead_review(p_deal_id text, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not (public.is_admin() or public.is_va()) then raise exception 'not authorized'; end if;
  update public.deals
     set meta = (coalesce(meta,'{}'::jsonb) - 'review_cleared_at')
                || jsonb_build_object('manual_review', jsonb_build_object(
                     'reason', nullif(btrim(coalesce(p_reason,'')), ''),
                     'by', auth.uid(), 'at', now()::text))
   where id = p_deal_id;
  insert into public.activity (deal_id, user_id, action, visibility)
  values (p_deal_id, auth.uid(),
          '🔎 Sent to Review' || coalesce(' — ' || nullif(btrim(p_reason),''), ''), array['team']);
end $$;
grant execute on function public.flag_lead_review(text, text) to authenticated;

create or replace function public.clear_lead_review(p_deal_id text, p_clear boolean default true)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not (public.is_admin() or public.is_va()) then raise exception 'not authorized'; end if;
  if p_clear then
    update public.deals
       set meta = (coalesce(meta,'{}'::jsonb) - 'manual_review') || jsonb_build_object('review_cleared_at', now()::text)
     where id = p_deal_id;
    insert into public.activity (deal_id, user_id, action, visibility)
    values (p_deal_id, auth.uid(), '🔎 Marked reviewed (cleared from review queue)', array['team']);
  else
    update public.deals set meta = (coalesce(meta,'{}'::jsonb) - 'review_cleared_at') where id = p_deal_id;
  end if;
end $$;
