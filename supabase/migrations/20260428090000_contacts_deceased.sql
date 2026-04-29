-- contacts.deceased: track deceased homeowners.
--
-- Per Nathan 2026-04-28: Eric is moving leads from GoHighLevel into the
-- DCC. Tier classification is:
--   A = equity ≥ $100k AND alive
--   B = equity ≥ $100k AND deceased
--   C = anything under $100k (alive or dead)
--
-- We need to flag deceased contacts so:
--   1. Tier B (estate / probate cases) is identifiable
--   2. Outreach skips deceased numbers (don't text someone who passed)
--   3. The UI shows a "deceased" badge so we never accidentally call
--      a person who died — bad look + emotionally awful for family
--
-- The existing `deals.death_signal` column is Castle-populated (set
-- when the scraper sees obit/probate signals on the docket). This new
-- contacts.deceased column is for hand-marked entries from Eric's
-- imports + manual UI toggles.

alter table public.contacts
  add column if not exists deceased boolean not null default false,
  add column if not exists deceased_at timestamptz,
  add column if not exists deceased_source text;

-- Index for "all deceased contacts" queries (small column, partial index keeps it tiny).
create index if not exists idx_contacts_deceased
  on public.contacts(deceased) where deceased = true;

comment on column public.contacts.deceased is
  'True if the homeowner has passed away. Drives Tier B classification + skips outreach.';
comment on column public.contacts.deceased_at is
  'When deceased was marked true (audit trail, not date of death).';
comment on column public.contacts.deceased_source is
  'Where the info came from — "obituary", "family", "skip-trace", "GHL-import", etc.';
