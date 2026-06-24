-- PERF (Nathan 2026-06-23): v_lead_review_queue had grown to ~11.7s — three
-- per-row correlated subqueries into contacts (any_phone / heir_phone / has_dnc)
-- plus the name-dup window and three regexes. Queried on every deals realtime
-- change (the badge), per deal open, and by the Call Queue, it saturated the DB
-- and dragged the whole app (Chat/Messages). Collapsing the 3 contact subqueries
-- into ONE lateral aggregate per deal took it to ~0.6s (~20x). Semantics
-- unchanged. Applied to prod via execute_sql (apply_migration timed out under the
-- load). Supersedes 20260623130000.
create or replace view public.v_lead_review_queue
with (security_invoker=on) as
with base as (
  select d.id, d.name, d.status, d.meta,
    coalesce(
      case when (d.meta ->> 'verifiedSurplus') ~ '^-?\d+(\.\d+)?$' then (d.meta ->> 'verifiedSurplus')::numeric else null::numeric end,
      case when (d.meta ->> 'estimatedSurplus') ~ '^-?\d+(\.\d+)?$' then (d.meta ->> 'estimatedSurplus')::numeric else null::numeric end,
      0::numeric) as surplus_amt,
    coalesce(nullif(trim(both from d.meta ->> 'homeownerPhone'), ''), nullif(trim(both from d.meta ->> 'phone'), ''), nullif(trim(both from d.meta ->> 'contactPhone'), ''), nullif(trim(both from d.meta ->> 'ownerPhone'), ''), cstats.a_phone) as any_phone,
    case when d.deceased = false then false when d.deceased = true then true when (d.meta ->> 'deceased') = 'false' then false else coalesce(d.death_signal, false) or ((d.meta ->> 'deceased') = any (array['true','t','1'])) end as v_deceased,
    coalesce(cstats.has_heir, false) as heir_phone,
    coalesce(cstats.has_dnc, false) as has_dnc,
    regexp_replace(coalesce((d.meta -> 'case_intel_summary') ->> 'text', ''), '[\n\r]+', ' ', 'g') as ai_text,
    (d.meta -> 'case_intel_summary') ->> 'generated_at' as ai_at,
    count(*) over (partition by (lower(trim(both from d.name)))) as name_dupes
  from deals d
  left join lateral (
    select max(p) filter (where p is not null) as a_phone,
      bool_or(p is not null and rel <> 'homeowner') as has_heir,
      bool_or(dnc) as has_dnc
    from (select nullif(trim(both from c.phone), '') as p, lower(coalesce(cd.relationship, '')) as rel, (c.do_not_call or c.do_not_text) as dnc
          from contact_deals cd join contacts c on c.id = cd.contact_id where cd.deal_id = d.id) x
  ) cstats on true
  where (d.prepped_at is not null or d.meta ? 'manual_review')
    and d.deleted_at is null and d.type = 'surplus' and (d.meta ->> 'review_cleared_at') is null
), flagged as (
  select base.*,
    case
      when base.meta ? 'manual_review' then 'manual_review'
      when base.has_dnc then 'dnc'
      when (base.status = any (array['dead','dismissed'])) or (base.meta ->> 'case_dismissed') = 'true' then 'dead_but_ready'
      when base.ai_text ~* '(already (been )?(retained|hired)|retained (an? )?(attorney|counsel|lawyer)|filed pro se|pro se (motion|petition|filing)|filed by defendant|petition for (release|distribution) of surplus)' then 'self_claim_risk'
      when base.ai_text ~* '(deal is dead|legally dead|no (surplus|excess|funds?) (exist|remain|left|available)|nothing (left|remaining) to (claim|recover)|\$0 (surplus|available|remaining|to (claim|recover))|(surplus|excess funds?|excess) (was|were|has been|have been|already)( already)? (claimed|distributed|disbursed|paid out|released|recovered)|already been (claimed|recovered) by|surplus (is|was|already) (gone|claimed|paid))' then 'verify_maybe_gone'
      when base.ai_text ~* '((junior|senior) lien|second mortgage|junior lienholder|senior lienholder|heloc|line of credit).{0,50}(consume|reduce|wipe|threaten|eat|cut|burn|distribut|remain|further claim|all (the )?equity)|(consume|reduce|wipe|threaten|eat|cut|distribut|burn)\w*.{0,50}((junior|senior) lien|second mortgage|lienholder)' then 'other_liens'
      when base.v_deceased and not base.heir_phone then 'deceased_no_heir'
      when base.any_phone is null then 'no_phone'
      when base.surplus_amt <= 0 then 'no_surplus_amount'
      when base.name_dupes > 1 then 'possible_duplicate'
      else null
    end as flag
  from base
)
select id as deal_id, name, round(surplus_amt)::bigint as surplus,
  case when flag in ('verify_maybe_gone','manual_review','self_claim_risk','other_liens') then 'verify_available' else 'not_callable' end as category,
  case flag
    when 'manual_review' then coalesce(meta->'manual_review'->>'reason', 'Flagged for a second look by the team')
    when 'dnc' then 'A linked contact is marked do-not-call / do-not-text — do not dial without checking why'
    when 'dead_but_ready' then 'Marked DEAD/dismissed but still in the ready pile — confirm and remove'
    when 'self_claim_risk' then 'AI brief suggests the homeowner is already acting (filed pro se, retained an attorney, or filed a surplus petition) — confirm it''s still ours before calling'
    when 'verify_maybe_gone' then 'AI brief flags the surplus may already be distributed — verify the docket before calling'
    when 'other_liens' then 'AI brief flags a junior/senior lien or 2nd mortgage that may consume the surplus — re-confirm the net amount before quoting'
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
    when 'manual_review' then 0 when 'dnc' then 1 when 'dead_but_ready' then 2 when 'self_claim_risk' then 3
    when 'verify_maybe_gone' then 4 when 'other_liens' then 5 when 'deceased_no_heir' then 6
    when 'no_phone' then 7 when 'no_surplus_amount' then 8 when 'possible_duplicate' then 9 else null
  end as priority
from flagged
where flag is not null;
