-- Sales workflow layer on top of the existing case-state `status` column.
--   status        = where the case is (filed / probate / awaiting-distribution)
--   sales_stage   = where the lead is in our outreach funnel (new / texted / responded / signed / ...)
-- Two parallel stage enums — surplus cases go through one flow, 30DTS
-- (auction < 30 days, may get wholesaled pre-sale) go through another.
alter table public.deals
  add column if not exists sales_stage text
    check (sales_stage in ('new', 'texted', 'responded', 'agreement-sent', 'signed', 'filed', 'paid-out', 'dead')),
  add column if not exists sales_stage_30dts text
    check (sales_stage_30dts in ('new', 'texted', 'responded', 'wholesale-offer', 'under-contract', 'auction', 'post-auction-surplus', 'dead')),
  add column if not exists last_contacted_at timestamptz;

create index if not exists idx_deals_sales_stage on public.deals(sales_stage) where sales_stage is not null;
create index if not exists idx_deals_sales_stage_30dts on public.deals(sales_stage_30dts) where sales_stage_30dts is not null;
create index if not exists idx_deals_lead_tier on public.deals(lead_tier) where lead_tier is not null;

update public.deals
set sales_stage = 'new'
where sales_stage is null
  and type in ('surplus', 'flip')
  and status not in ('closed', 'dead', 'recovered');

update public.deals
set sales_stage_30dts = 'new'
where sales_stage_30dts is null
  and is_30dts = true
  and status not in ('closed', 'dead', 'recovered');

-- Activity → last_contacted_at: whenever a new activity row lands whose
-- action starts with one of the contact verbs, bump last_contacted_at on
-- the deal. Keeps staleness sorting accurate without Eric updating two places.
create or replace function public.bump_last_contacted_on_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.action is null then return NEW; end if;
  if NEW.action ~* '^(texted|called|emailed|sms|message sent|sent |log(ged)? call)'
     or NEW.action ~* '(message notification emailed|sms:)' then
    update public.deals
    set last_contacted_at = greatest(coalesce(last_contacted_at, '-infinity'::timestamptz), NEW.created_at)
    where id = NEW.deal_id;
  end if;
  return NEW;
end;
$$;

drop trigger if exists tg_bump_last_contacted on public.activity;
create trigger tg_bump_last_contacted
  after insert on public.activity
  for each row
  execute function public.bump_last_contacted_on_activity();

comment on column public.deals.sales_stage is
  'Sales funnel stage (parallel to status which is case state). new/texted/responded/agreement-sent/signed/filed/paid-out/dead.';
comment on column public.deals.sales_stage_30dts is
  'Parallel sales funnel for 30DTS deals (auction within 30 days). Bumps here when is_30dts flips true.';
comment on column public.deals.last_contacted_at is
  'Maintained by tg_bump_last_contacted trigger on activity INSERTs. Used for staleness sorting in the pipeline.';
