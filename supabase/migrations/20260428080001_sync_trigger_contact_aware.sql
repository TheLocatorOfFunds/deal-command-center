-- Update tg_sync_personalized_link_from_deal to be contact-aware.
--
-- The existing trigger (from 20260428060000) writes the deal owner's
-- name, address, and meta fields onto every personalized_links row
-- that shares the deal_id. After 20260428080000 a single deal can have
-- multiple rows — one for the homeowner (contact_id IS NULL) and one
-- for each non-owner contact (contact_id = contacts.id).
--
-- For non-owner rows, the contact's own first_name / last_name / phone
-- belong to that contact, NOT to the deal owner. The deal-level fields
-- (property_address, county, case_number, sale info, surplus) still
-- sync to all rows because they're case-level facts everyone sees.

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
  if not exists (select 1 from public.personalized_links where deal_id = new.id) then
    return new;
  end if;

  -- Update HOMEOWNER row (contact_id IS NULL) — name + everything.
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
  where pl.deal_id = new.id and pl.contact_id is null;

  -- Update CONTACT-SPECIFIC rows (contact_id IS NOT NULL) — sync only
  -- the deal-level facts. Don't touch first_name / last_name / phone —
  -- those belong to the contact, not the deal owner.
  update public.personalized_links pl set
    property_address = coalesce(new.address, pl.property_address),
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
  where pl.deal_id = new.id and pl.contact_id is not null;

  return new;
end;
$$;

-- Also a trigger on contacts: when a contact's name or phone changes,
-- the corresponding personalized_links rows should follow.
create or replace function public._sync_personalized_link_from_contact()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.personalized_links where contact_id = new.id) then
    return new;
  end if;

  update public.personalized_links pl set
    first_name = case
                   when new.name is not null and new.name <> ''
                   then split_part(trim(new.name), ' ', 1)
                   else pl.first_name
                 end,
    last_name  = case
                   when new.name is not null and new.name <> ''
                        and position(' ' in trim(new.name)) > 0
                   then trim(substring(trim(new.name) from position(' ' in trim(new.name)) + 1))
                   else pl.last_name
                 end,
    phone      = coalesce(new.phone, pl.phone)
  where pl.contact_id = new.id;

  return new;
end;
$$;

drop trigger if exists tg_sync_personalized_link_from_contact on public.contacts;
create trigger tg_sync_personalized_link_from_contact
  after update of name, phone on public.contacts
  for each row execute function public._sync_personalized_link_from_contact();
