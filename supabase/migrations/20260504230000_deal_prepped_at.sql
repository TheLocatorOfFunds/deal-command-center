-- Lead prep queue — flag for "Eric still needs to work this lead."
--
-- Per Nathan 2026-05-04: when a new lead lands in DCC (from ohio-intel
-- push, CSV import, manual entry, etc.) it should sit in a queue Eric
-- works through — confirm phone, label contact relationships, set tier,
-- verify surplus est, generate personalized URL, etc. — before it
-- enters the cold-outreach pipeline.
--
-- Implementation: a single nullable timestamp on the deal.
--   - prepped_at IS NULL  → still in Eric's prep queue
--   - prepped_at IS NOT NULL → prep is done; Eric clicked "Mark prepped"
--
-- Backfill: anything past the lead phase right now (signed / filed /
-- probate / awaiting-distribution / closed / etc.) is already through
-- prep, so we mark them prepped at their last update time. Lead-phase
-- deals (status='lead' or 'new-lead') stay unprepped — they ARE the
-- starting queue Eric works tomorrow.

alter table public.deals
  add column if not exists prepped_at timestamptz;

create index if not exists idx_deals_unprepped
  on public.deals (created_at desc)
  where prepped_at is null;

update public.deals
set prepped_at = coalesce(updated_at, created_at)
where prepped_at is null
  and status not in ('lead', 'new-lead');

comment on column public.deals.prepped_at is
  'When Eric (or whoever) finished prepping the lead — phone confirmed, contacts added + relationships labeled, tier set, surplus estimate verified, personalized URL generated. NULL means it''s in the prep queue on the Today view.';
