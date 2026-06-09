-- 20260609190000_sync_meta_from_homeowner_contact.sql
--
-- Phase 2 of "homeowner is a real contact" (paired with the Comms-tab UI
-- flip in this same PR). Phase 1 (#320) added a meta -> contact trigger so
-- every existing homeowner gets mirrored as a public.contacts row. This
-- migration adds the REVERSE direction:
--
--   When a homeowner-kind contact is updated, write the change back to every
--   deal where it's linked as the homeowner (relationship ilike 'homeowner%').
--
-- With both triggers in place, the contact becomes the source of truth for
-- the Comms-tab pencil (the UI now writes public.contacts, not deal.meta),
-- and meta stays in sync so the 74 legacy meta-readers in src/app.jsx and
-- the 7 edge functions still see the right values until Phase 3 migrates
-- them off meta entirely.
--
-- Loop safety: both triggers short-circuit when the relevant fields are
-- already equal. Walk-through:
--   1. UI updates contacts.name = 'Joseph' (was 'Joe')
--   2. tg_sync_meta_from_homeowner_contact fires -> writes
--      deals.meta.homeownerName = 'Joseph'
--   3. tg_sync_homeowner_contact (from Phase 1) fires on deals UPDATE,
--      sees OLD.meta.homeownerName <> NEW.meta.homeownerName, calls
--      sync_homeowner_contact -> updates contacts.name = 'Joseph' (same)
--   4. tg_sync_meta_from_homeowner_contact fires again, but
--      NEW.name = OLD.name = 'Joseph', so it skips. Loop terminates.

create or replace function public.tg_sync_meta_from_homeowner_contact()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  new_meta jsonb;
begin
  -- Only act when this row IS or WAS a homeowner-kind contact. Skips the
  -- vast majority of contacts UPDATEs (attorneys, vendors, etc).
  if NEW.kind is distinct from 'homeowner' and OLD.kind is distinct from 'homeowner' then
    return NEW;
  end if;

  -- Skip the no-op case: if name/phone/email all unchanged, the upstream
  -- trigger has nothing to do, so don't fire a deals UPDATE.
  if NEW.name is not distinct from OLD.name
     and NEW.phone is not distinct from OLD.phone
     and NEW.email is not distinct from OLD.email
  then
    return NEW;
  end if;

  -- Sync to every deal where this contact is linked as the homeowner.
  -- relationship match uses ilike 'homeowner%' to catch 'Homeowner',
  -- 'homeowner of property', etc. Falls back to kind='homeowner' so a
  -- contact tagged as homeowner with an empty/custom relationship still
  -- syncs.
  for r in
    select cd.deal_id, d.meta
      from public.contact_deals cd
      join public.deals d on d.id = cd.deal_id
     where cd.contact_id = NEW.id
       and (cd.relationship ilike 'homeowner%' or NEW.kind = 'homeowner')
  loop
    new_meta := coalesce(r.meta, '{}'::jsonb);

    -- Write each field only if the contact has a value. We don't BLANK
    -- meta when the contact has a NULL field - that would silently nuke
    -- legacy meta that other readers might still depend on. Phase 3
    -- removes meta entirely so this clamp is short-lived.
    if NEW.name is not null and NEW.name <> '' then
      new_meta := new_meta || jsonb_build_object('homeownerName', NEW.name);
    end if;
    if NEW.phone is not null and NEW.phone <> '' then
      new_meta := new_meta || jsonb_build_object('homeownerPhone', NEW.phone);
    end if;
    if NEW.email is not null and NEW.email <> '' then
      new_meta := new_meta || jsonb_build_object('homeownerEmail', NEW.email);
    end if;

    -- Only fire the deals UPDATE if meta would actually change. This is
    -- the loop-breaker for the bidirectional sync: when tg_sync_homeowner_contact
    -- writes a no-op contacts UPDATE in step 3 of the walkthrough above,
    -- new_meta will equal r.meta and we skip the write here.
    if new_meta is distinct from r.meta then
      update public.deals set meta = new_meta where id = r.deal_id;
    end if;
  end loop;
  return NEW;
end;
$$;

comment on function public.tg_sync_meta_from_homeowner_contact is
  'Phase 2 of the homeowner-as-contact migration (2026-06-09). When a '
  'homeowner-kind contact is updated, propagates name/phone/email into '
  'deal.meta.homeowner{Name,Phone,Email} on every linked deal. Loop-safe via '
  'no-op guards in both directions.';

drop trigger if exists tg_sync_meta_from_homeowner_contact on public.contacts;
create trigger tg_sync_meta_from_homeowner_contact
  after update on public.contacts
  for each row
  execute function public.tg_sync_meta_from_homeowner_contact();
