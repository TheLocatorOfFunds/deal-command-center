-- Per-contact personalized URLs.
--
-- Per Nathan 2026-04-28: today every personalized_links row is keyed
-- only to a deal — Richard Mikol's URL is "richardmikol", and the
-- public page renders him-as-homeowner copy. Nathan wants per-CONTACT
-- URLs too: Michelle (Richard's daughter) gets her own URL with copy
-- written to her, Melinda gets hers, the surviving spouse gets hers,
-- etc. Each contact-specific URL still surfaces the same case data
-- (the deal's property / surplus / sale info) but with relationship-
-- aware text so the recipient instantly sees themselves in it.
--
-- Slug pattern (per Nathan): {owner-slug}-{contact-firstname}, e.g.
-- "richardmikol-michelle", "richardmikol-melinda". The owner slug
-- stays canonical for the homeowner ("richardmikol") so the family
-- thread is visible at a glance.
--
-- Schema changes:
-- 1. contact_id (uuid, nullable) — links to contacts.id when this row
--    is for a non-owner contact. NULL means "this URL is the home-
--    owner's view" (preserves backward-compat with all existing rows).
-- 2. relationship (text, default 'homeowner') — drives the copy
--    templates the public page + OG image render. Check-constrained
--    to a closed vocabulary so typos don't break copy lookups.
-- 3. Existing rows backfilled to relationship='homeowner' / contact_id=NULL.

alter table public.personalized_links
  add column if not exists contact_id uuid references public.contacts(id) on delete set null,
  add column if not exists relationship text not null default 'homeowner';

-- Closed vocabulary for relationship — tied to copy templates on the
-- public page + the OG image. Add new values here AND add the matching
-- copy template before deploying.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'personalized_links_relationship_check'
      and conrelid = 'public.personalized_links'::regclass
  ) then
    alter table public.personalized_links
      add constraint personalized_links_relationship_check
      check (relationship in (
        'homeowner',
        'spouse',
        'child',
        'parent',
        'sibling',
        'other'
      ));
  end if;
end $$;

-- One URL per (deal, contact) combo. NULL contact_id is the homeowner's
-- URL — keep at most one of those per deal too. UNIQUE NULLS NOT DISTINCT
-- ensures Postgres treats two NULLs as a collision (would otherwise
-- allow infinite homeowner-rows per deal).
--
-- Partial: skip rows with deal_id IS NULL — those are Castle's orphan
-- auction-discovered rows (per CLAUDE.md, deal_id is nullable for that
-- pre-engagement bucket). Multiple orphan rows are fine.
create unique index if not exists uq_personalized_links_deal_contact
  on public.personalized_links (deal_id, contact_id)
  nulls not distinct
  where deal_id is not null;

-- Backfill existing rows. They were all minted before per-contact
-- existed, so they're all homeowner views. Default already does this
-- for new rows; this just makes the historical state explicit.
update public.personalized_links
   set relationship = 'homeowner'
 where relationship is null;

create index if not exists idx_personalized_links_contact
  on public.personalized_links(contact_id) where contact_id is not null;
