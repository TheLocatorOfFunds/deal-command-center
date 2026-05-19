-- Backfill: GHL-imported family contacts that pre-date the
-- mapGhlRowToDcc fix (commit dfd9d57, 2026-05-08) were inserted with
-- relationship='other'. New imports default to 'family'. Bring the
-- historical rows forward so the UI + any future analytics line up
-- with the new default.
--
-- Safe to re-run: idempotent. The WHERE clause filters to 'other', so
-- a second run finds no matching rows.
--
-- Scope: ONLY contacts the GHL importer tagged 'family-contact'.
-- Contacts hand-created elsewhere with relationship='other' (true
-- 'other' relationships, not coming from the GHL family loop) are NOT
-- touched because they don't have the 'family-contact' tag.

update public.contact_deals
set relationship = 'family'
where relationship = 'other'
  and contact_id in (
    select id from public.contacts
    where tags @> array['family-contact']
  );

-- For visibility — uncomment after running to count what changed:
-- select count(*) from public.contact_deals cd
-- join public.contacts c on c.id = cd.contact_id
-- where cd.relationship = 'family'
--   and c.tags @> array['family-contact'];
