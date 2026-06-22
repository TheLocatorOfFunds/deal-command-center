-- Smarter Daily Worklist backing fn (#6, Nathan 2026-06-22). One ranked list of
-- today's highest-value actions: urgent deadlines + review queue + ready-to-call
-- (clean, never-contacted) + gone-quiet follow-ups. Dedups each deal to its single
-- most-urgent action, ranks by urgency×value. SECURITY INVOKER so deals RLS still
-- applies (no leak to anon). Deadlines bounded to a -7..+30d actionable window so
-- ancient passed dates don't drown the list. Applied to prod via MCP apply_migration.
create or replace function public.get_daily_worklist(p_limit int default 25)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
with
val as (
  select d.id, d.name, d.type, d.status, d.prepped_at, d.last_contacted_at,
         d.redemption_deadline, d.deadline,
         coalesce(d.verified_surplus, d.surplus_estimate,
                  nullif(d.meta->>'estimatedSurplus','')::numeric,
                  nullif(d.meta->>'surplus','')::numeric, 0) as sval
  from deals d
  where d.deleted_at is null
),
rq as ( select deal_id, flag, reason, surplus from v_lead_review_queue ),
items as (
  select v.id as deal_id, v.name, 'deadline'::text as kind,
         coalesce(v.redemption_deadline, v.deadline) as when_date, v.sval as value,
         (coalesce(v.redemption_deadline, v.deadline) - current_date) as days_until,
         null::text as flag, null::text as reason
  from val v
  where v.status not in ('closed','recovered','dead')
    and coalesce(v.redemption_deadline, v.deadline) between current_date - 7 and current_date + 30

  union all
  select rq.deal_id, v.name, 'review', null::date, rq.surplus, null::int, rq.flag, rq.reason
  from rq join val v on v.id = rq.deal_id

  union all
  select v.id, v.name, 'call', null::date, v.sval, null::int, null, null
  from val v
  where v.type='surplus' and v.prepped_at is not null and v.last_contacted_at is null
    and v.status not in ('closed','recovered','dead') and v.sval >= 5000
    and not exists (select 1 from rq where rq.deal_id = v.id)

  union all
  select v.id, v.name, 'followup', null::date, v.sval, null::int, null, null
  from val v
  where v.type='surplus' and v.prepped_at is not null
    and v.last_contacted_at is not null and v.last_contacted_at < now() - interval '7 days'
    and v.status not in ('closed','recovered','dead')
    and not exists (select 1 from rq where rq.deal_id = v.id)
),
scored as (
  select *,
    case kind
      when 'deadline' then 1000 - least(days_until, 30)
      when 'review'   then 600 + least(coalesce(value,0)/10000, 50)
      when 'call'     then 400 + least(value/10000, 80)
      when 'followup' then 200 + least(value/10000, 50)
    end as score
  from items
),
dedup as ( select distinct on (deal_id) * from scored order by deal_id, score desc )
select coalesce(jsonb_agg(to_jsonb(s) order by s.score desc), '[]'::jsonb)
from ( select * from dedup order by score desc limit p_limit ) s;
$$;
grant execute on function public.get_daily_worklist(int) to authenticated;
