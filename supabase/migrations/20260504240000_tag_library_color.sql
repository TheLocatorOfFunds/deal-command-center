-- Tag color column on the persistent vocabulary.
-- Per Eric (relayed via Nathan, 2026-05-04): "tag the leads/deals
-- so we can identify if there's something unusual" — to make the
-- visual signal stronger, each tag gets one of 6 preset colors so
-- "wait" can stand out red, "high-equity" can be green, etc.
--
-- Allowlist enforced at the DB layer so a typo / bad value can't
-- get in. Default 'gold' matches the existing chip styling so
-- nothing visually changes for tags created before this column.

alter table public.tag_library
  add column if not exists color text not null default 'gold';

alter table public.tag_library
  drop constraint if exists tag_library_color_check;

alter table public.tag_library
  add constraint tag_library_color_check
  check (color in ('gold', 'red', 'green', 'blue', 'purple', 'gray'));

comment on column public.tag_library.color is
  'Visual category for the tag chip. One of: gold (default), red, green, blue, purple, gray. Allowlisted at the DB layer so the UI palette stays consistent.';
