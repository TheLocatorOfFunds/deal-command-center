-- Auto-sync deal data into personalized_links rows.
--
-- Background: the website's /s/<token> page renders sale_date / sale_price /
-- judgment_amount / estimated_surplus from the personalized_links row. Those
-- values are seeded at Generate URL time from deal.meta — but if Nathan
-- later edits the deal in DCC (e.g. fills in the actual sale price after
-- the auction), the existing personalized_links row stays stale and the
-- public page keeps showing the old values.
--
-- Trigger: after any UPDATE on deals, propagate the relevant fields into
-- every personalized_links row that shares the deal_id. Fields synced:
-- property_address, county, case_number, sale_date, sale_price,
-- judgment_amount, estimated_surplus_low/high, first_name, last_name.
--
-- Idempotent + side-effect-free if there's no matching row.

create or replace function public._sync_personalized_link_from_deal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_meta       jsonb := coalesce(new.meta, '{}'::jsonb);
  v_name_parts text[] := regexp_split_to_array(coalesce(new.name, ''), '\s+');
  v_first      text  := nullif(trim(v_name_parts[1]), '');
  v_last       text  := case
                          when array_length(v_name_parts, 1) > 1
                          then nullif(trim(array_to_string(v_name_parts[2:array_length(v_name_parts,1)], ' ')), '')
                          else null
                        end;
  v_surplus    numeric := nullif(v_meta->>'estimatedSurplus', '')::numeric;
begin
  -- Only fire if the deal actually has a personalized_link to sync.
  if not exists (select 1 from public.personalized_links where deal_id = new.id) then
    return new;
  end if;

  update public.personalized_links pl set
    property_address = coalesce(new.address, pl.property_address),
    first_name       = coalesce(v_first, pl.first_name),
    last_name        = coalesce(v_last,  pl.last_name),
    county           = coalesce(nullif(v_meta->>'county', ''), pl.county),
    case_number      = coalesce(
                         nullif(v_meta->>'courtCase', ''),
                         nullif(v_meta->>'caseNumber', ''),
                         nullif(v_meta->>'case_number', ''),
                         pl.case_number
                       ),
    sale_date        = coalesce(nullif(v_meta->>'saleDate', '')::date,        pl.sale_date),
    sale_price       = coalesce(nullif(v_meta->>'salePrice', '')::numeric,    pl.sale_price),
    judgment_amount  = coalesce(nullif(v_meta->>'judgmentAmount', '')::numeric, pl.judgment_amount),
    estimated_surplus_low  = coalesce(
                              nullif(v_meta->>'estimatedSurplusLow', '')::numeric,
                              v_surplus,
                              pl.estimated_surplus_low
                            ),
    estimated_surplus_high = coalesce(
                              nullif(v_meta->>'estimatedSurplusHigh', '')::numeric,
                              v_surplus,
                              pl.estimated_surplus_high
                            )
  where pl.deal_id = new.id;

  return new;
end;
$$;

drop trigger if exists tg_sync_personalized_link_from_deal on public.deals;
create trigger tg_sync_personalized_link_from_deal
  after update on public.deals
  for each row execute function public._sync_personalized_link_from_deal();

comment on function public._sync_personalized_link_from_deal is
  'After an UPDATE on deals, push name + address + meta.{saleDate,salePrice,judgmentAmount,courtCase,county,estimatedSurplus} into matching personalized_links rows. Lets Nathan fill in case data in DCC and have the public /s/<token> page reflect it without regenerating the URL.';
