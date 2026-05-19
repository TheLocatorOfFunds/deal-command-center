-- deals.tags — free-form text labels per deal.
--
-- Per Eric (relayed via Nathan, 2026-05-04): "tag the leads/deals so we
-- can filter better and identify if there's something unusual going on
-- with the case." Like GHL — also removable when no longer needed.
--
-- Free-form text (not curated) so VAs can flag whatever's salient
-- ("heir-dispute", "high-equity", "needs-skip-trace", "WAIT"). Mirrors
-- the existing contacts.tags pattern.
--
-- Postgres array column with a GIN index so filter queries
-- (`tags @> ARRAY['heir-dispute']`) are fast even at thousands of deals.

alter table public.deals
  add column if not exists tags text[] not null default '{}'::text[];

create index if not exists idx_deals_tags on public.deals using gin (tags);

comment on column public.deals.tags is 'Free-form labels for filtering / human flagging. Add via UI on deal detail; remove via the × on each chip. Curated by team — no enforced vocabulary.';
