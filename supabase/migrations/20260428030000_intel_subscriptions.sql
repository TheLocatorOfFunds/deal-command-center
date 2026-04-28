-- ohio-intel ↔ DCC bridge: schema layer.
--
-- Phase 2 of the migration plan ("auto-subscribe"). Every DCC deal with a
-- court case# + county becomes a subscription that the intel-sync edge
-- function pulls into DCC's docket_events table from ohio-intel's Supabase.
--
-- Strategy = option C (tag-and-tolerate) for now: Castle still writes to
-- docket_events directly; ohio-intel-sourced rows get marked source =
-- 'ohio_intel'. Some duplication is OK during the transition. Plan is to
-- migrate to option A (ohio-intel as sole writer) once ohio-intel covers
-- ≥10 counties.
--
-- See ~/Documents/Claude/ohio-intel/db/migrations/0001_initial.sql for
-- ohio-intel's ohio_case + docket_event schemas.

-- 1. Tag every existing docket_events row as Castle-sourced. New ohio-intel
-- rows will set source='ohio_intel'. Default 'castle' so any other writers
-- (manual SQL inserts, etc.) get tagged correctly without code changes.
alter table public.docket_events
  add column if not exists source text not null default 'castle';

create index if not exists idx_docket_events_source
  on public.docket_events(source);

comment on column public.docket_events.source is
  'Where this event came from. ''castle'' = Castle scraper writing direct to DCC (legacy path). ''ohio_intel'' = synced via intel-sync EF from the ohio-intel project. Plan to retire ''castle'' once ohio-intel covers all engaged counties.';

-- 2. Subscriptions table. One row per DCC deal that has a case# + county.
-- The intel-sync EF iterates this table, looks up matching ohio_case rows
-- in ohio-intel, and upserts new docket_events into DCC.
create table if not exists public.intel_subscriptions (
  deal_id              text primary key references public.deals(id) on delete cascade,
  case_number          text not null,
  county               text not null,
  case_type            text not null default 'foreclosure'
    check (case_type in ('foreclosure','probate','tax_delinquent','code_violation')),
  intel_case_id        uuid,
  status               text not null default 'pending'
    check (status in ('pending','matched','no_match','county_unbuilt','error')),
  last_synced_at       timestamptz,
  last_error           text,
  events_synced_count  int not null default 0,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists idx_intel_subscriptions_status
  on public.intel_subscriptions(status, last_synced_at nulls first);

comment on table public.intel_subscriptions is
  'DCC deals registered for ohio-intel docket monitoring. The intel-sync EF cron walks this table every 30 min, looks up ohio_case rows in ohio-intel''s Supabase, and upserts new docket_events into DCC. status: pending = not yet looked up, matched = found in ohio-intel and synced, no_match = ohio-intel covers the county but the case isn''t there yet, county_unbuilt = ohio-intel doesn''t cover this county yet, error = last sync threw.';

alter table public.intel_subscriptions enable row level security;

drop policy if exists admin_all_intel_subs on public.intel_subscriptions;
create policy admin_all_intel_subs on public.intel_subscriptions
  for all to authenticated
  using (public.is_admin() or public.is_va())
  with check (public.is_admin() or public.is_va());

-- 3. Trigger to keep intel_subscriptions in lockstep with deals. Fires on
-- any deals INSERT or any UPDATE that touches the meta column. Reads
-- meta.courtCase + meta.county and upserts a subscription. If those
-- fields aren't both set, no-op.
create or replace function public._ensure_intel_subscription()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_case   text := nullif(trim(coalesce(new.meta->>'courtCase', '')), '');
  v_county text := nullif(trim(coalesce(new.meta->>'county', '')), '');
begin
  if v_case is null or v_county is null then
    -- Deal doesn't have both case# + county; clear subscription if one exists
    delete from public.intel_subscriptions where deal_id = new.id;
    return new;
  end if;

  insert into public.intel_subscriptions (deal_id, case_number, county)
  values (new.id, v_case, v_county)
  on conflict (deal_id) do update
    set case_number = excluded.case_number,
        county      = excluded.county,
        updated_at  = now(),
        -- If case# or county changed, force a fresh lookup
        status = case
          when intel_subscriptions.case_number <> excluded.case_number
            or intel_subscriptions.county      <> excluded.county
          then 'pending'
          else intel_subscriptions.status
        end,
        intel_case_id = case
          when intel_subscriptions.case_number <> excluded.case_number
            or intel_subscriptions.county      <> excluded.county
          then null
          else intel_subscriptions.intel_case_id
        end;

  return new;
end;
$$;

drop trigger if exists tg_ensure_intel_subscription on public.deals;
create trigger tg_ensure_intel_subscription
  after insert or update of meta on public.deals
  for each row execute function public._ensure_intel_subscription();

-- 4. Backfill subscriptions for existing deals so we don't have to wait
-- for someone to edit each one before the sync notices it.
insert into public.intel_subscriptions (deal_id, case_number, county)
select
  d.id,
  trim(d.meta->>'courtCase'),
  trim(d.meta->>'county')
from public.deals d
where d.meta->>'courtCase' is not null
  and trim(d.meta->>'courtCase') <> ''
  and d.meta->>'county' is not null
  and trim(d.meta->>'county') <> ''
on conflict (deal_id) do nothing;
