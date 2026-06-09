-- 20260609180000_homeowner_as_contact.sql
--
-- Phase 1 of "homeowner is a real contact" (Justin 2026-06-09: 'every contact
-- should be a public contact, and we can put a tag on it that says it's the
-- homeowner of a certain deal. I don't like having contacts in two places.').
--
-- Today the homeowner lives in deal.meta.homeowner{Name,Phone,Email}. 74
-- references across src/app.jsx + 7 edge functions read from that meta
-- directly, including outbound-SMS routing through the iPhone bridge. So this
-- migration is the SAFE first step:
--
--   * Create + maintain a real public.contacts row for the homeowner of each
--     deal (kind='homeowner', linked via contact_deals.relationship='homeowner').
--   * Backfill every existing deal that has homeowner meta keys.
--   * Trigger that keeps the contact in sync whenever deal.meta changes.
--   * Meta STAYS the source of truth for now. The contact is a derived mirror.
--
-- Phase 2 (follow-up session) flips the source of truth to contacts + adds the
-- reverse sync. Phase 3 stops writing meta entirely. That phasing is what lets
-- us avoid a one-shot rewrite of 74 call sites + 7 EFs in a single PR.

-- ─── Helper: sync_homeowner_contact(deal_id) ──────────────────────────────
-- Idempotent. Safe to call repeatedly. Reads meta, ensures a homeowner-kind
-- contact + link exists. Updates existing contact if matched.
create or replace function public.sync_homeowner_contact(p_deal_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_meta jsonb;
  v_name text;
  v_phone text;
  v_email text;
  v_contact_id uuid;
begin
  select meta into v_meta from public.deals where id = p_deal_id;
  if v_meta is null then return; end if;

  -- Read the canonical homeowner fields. Same precedence as dealMetaPhone in
  -- src/app.jsx:256: homeownerPhone > phone > contactPhone > homeowner_phone.
  v_name  := coalesce(
              nullif(trim(v_meta->>'homeownerName'),  ''),
              nullif(trim(v_meta->>'homeowner_name'), '')
             );
  v_phone := coalesce(
              nullif(trim(v_meta->>'homeownerPhone'),  ''),
              nullif(trim(v_meta->>'phone'),           ''),
              nullif(trim(v_meta->>'contactPhone'),    ''),
              nullif(trim(v_meta->>'homeowner_phone'), '')
             );
  v_email := nullif(trim(v_meta->>'homeownerEmail'), '');

  -- Nothing to sync from. Skip rather than create an empty contact.
  if v_name is null and v_phone is null and v_email is null then
    return;
  end if;

  -- ── 1. Look for an existing homeowner-tagged contact already linked here.
  select cd.contact_id into v_contact_id
    from public.contact_deals cd
    join public.contacts c on c.id = cd.contact_id
   where cd.deal_id = p_deal_id
     and (cd.relationship ilike 'homeowner%' or c.kind = 'homeowner')
   order by cd.created_at asc nulls last
   limit 1;

  -- ── 2. Fall back to phone-matching any already-linked contact on this
  --      deal. Protects against duplicates when a homeowner was added
  --      manually before this migration ran. We only collapse onto an
  --      existing link (not a global contact-table match) to avoid
  --      accidentally re-using a contact who shares a phone but isn't
  --      this deal's homeowner.
  if v_contact_id is null and v_phone is not null then
    select cd.contact_id into v_contact_id
      from public.contact_deals cd
      join public.contacts c on c.id = cd.contact_id
     where cd.deal_id = p_deal_id
       and (c.phone = v_phone
         or c.phone = regexp_replace(v_phone, '^\+1', '')
         or regexp_replace(coalesce(c.phone,''), '\D', '')
             = regexp_replace(v_phone, '\D', '')
       )
     order by cd.created_at asc nulls last
     limit 1;
  end if;

  if v_contact_id is null then
    -- ── 3a. Create the contact + link. New rows get kind='homeowner'.
    insert into public.contacts (name, phone, email, kind, notes)
    values (
      coalesce(v_name, 'Homeowner'),
      v_phone,
      v_email,
      'homeowner',
      'Auto-synced from deal.meta on ' || to_char(now(), 'YYYY-MM-DD') ||
        '. Source of truth migrates to this row in Phase 2.'
    )
    returning id into v_contact_id;

    insert into public.contact_deals (contact_id, deal_id, relationship)
    values (v_contact_id, p_deal_id, 'homeowner');
  else
    -- ── 3b. Update existing row + link. Important: do NOT clobber kind if
    --       the contact was manually classified as something else (attorney,
    --       investor, etc) and got matched only via phone. Only set kind to
    --       'homeowner' when it was null or the generic 'other'.
    update public.contacts
       set name  = coalesce(v_name, name),
           phone = coalesce(v_phone, phone),
           email = coalesce(v_email, email),
           kind  = case when kind is null or kind = '' or kind = 'other'
                        then 'homeowner'
                        else kind
                   end
     where id = v_contact_id;

    -- Stamp relationship='homeowner' only if it's blank. Preserve any custom
    -- relationship the team set ("homeowner of property", etc).
    update public.contact_deals
       set relationship = case
                            when relationship is null or relationship = ''
                            then 'homeowner'
                            else relationship
                          end
     where contact_id = v_contact_id
       and deal_id = p_deal_id;
  end if;
end;
$$;

grant execute on function public.sync_homeowner_contact(text) to authenticated;

comment on function public.sync_homeowner_contact is
  'Phase 1 of the homeowner-as-contact migration (2026-06-09). Idempotently '
  'mirrors deal.meta.homeowner{Name,Phone,Email} into a contacts row tagged '
  'kind=homeowner with a contact_deals link relationship=homeowner. Meta '
  'remains the source of truth until Phase 2.';

-- ─── Trigger: keep the contact in sync as meta changes ────────────────────
-- Fires on deals INSERT and on UPDATE when any of the homeowner meta keys
-- change. Skips the no-op case so we are not running this on every single
-- deals UPDATE (intel-main bulk syncs hit a lot of rows).
create or replace function public.tg_sync_homeowner_contact()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if TG_OP = 'UPDATE' then
    if coalesce(OLD.meta->>'homeownerName',   '') = coalesce(NEW.meta->>'homeownerName',   '')
   and coalesce(OLD.meta->>'homeownerPhone',  '') = coalesce(NEW.meta->>'homeownerPhone',  '')
   and coalesce(OLD.meta->>'homeownerEmail',  '') = coalesce(NEW.meta->>'homeownerEmail',  '')
   and coalesce(OLD.meta->>'homeowner_name',  '') = coalesce(NEW.meta->>'homeowner_name',  '')
   and coalesce(OLD.meta->>'homeowner_phone', '') = coalesce(NEW.meta->>'homeowner_phone', '')
   and coalesce(OLD.meta->>'contactPhone',    '') = coalesce(NEW.meta->>'contactPhone',    '')
   and coalesce(OLD.meta->>'phone',           '') = coalesce(NEW.meta->>'phone',           '')
    then
      return NEW;
    end if;
  end if;
  perform public.sync_homeowner_contact(NEW.id);
  return NEW;
end;
$$;

drop trigger if exists tg_sync_homeowner_contact on public.deals;
create trigger tg_sync_homeowner_contact
  after insert or update on public.deals
  for each row
  execute function public.tg_sync_homeowner_contact();

-- ─── Backfill ─────────────────────────────────────────────────────────────
-- Run once for every existing deal that has any homeowner-keyed meta entry.
-- Inside a DO block so syntax errors abort the whole migration cleanly.
do $$
declare
  r record;
  v_done int := 0;
begin
  for r in
    select id from public.deals
     where meta ? 'homeownerName'
        or meta ? 'homeowner_name'
        or meta ? 'homeownerPhone'
        or meta ? 'homeowner_phone'
        or meta ? 'homeownerEmail'
        or meta ? 'contactPhone'
        or meta ? 'phone'
  loop
    perform public.sync_homeowner_contact(r.id);
    v_done := v_done + 1;
  end loop;
  raise notice 'sync_homeowner_contact: backfilled % deals', v_done;
end $$;
