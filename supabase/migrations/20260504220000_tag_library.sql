-- Persistent tag vocabulary — tags survive even when no deal currently
-- has them. Per Eric 2026-05-04: removing a tag from every deal made
-- the tag vanish from quick-add suggestions, so VAs had to retype it
-- next time. Autocomplete should remember every tag ever used.
--
-- Design:
--   - `tag_library` table is the canonical vocabulary
--   - AFTER UPDATE trigger on `deals.tags` upserts new tags into the
--     library on every save; removing a tag from a deal does NOT
--     remove it from the library (library is monotone-additive)
--   - Backfill the library from current `deals.tags` arrays so any
--     tag in use right now stays available
--
-- Cleanup tooling (rename / merge typos / delete unused tags) is a
-- separate v2 — for now the table is monotone, with deletes only via
-- direct SQL by an admin if a real typo gets in.

create table if not exists public.tag_library (
  name        text primary key,
  created_at  timestamptz not null default now(),
  created_by  uuid references auth.users(id) on delete set null
);

alter table public.tag_library enable row level security;

drop policy if exists "tag_library_team_read" on public.tag_library;
create policy "tag_library_team_read" on public.tag_library
  for select to authenticated
  using (public.is_admin() or public.is_va());

drop policy if exists "tag_library_team_write" on public.tag_library;
create policy "tag_library_team_write" on public.tag_library
  for insert to authenticated
  with check (public.is_admin() or public.is_va());

-- Admin-only delete (in case someone needs to clean up a typo)
drop policy if exists "tag_library_admin_delete" on public.tag_library;
create policy "tag_library_admin_delete" on public.tag_library
  for delete to authenticated
  using (public.is_admin());

-- Index for prefix / substring autocomplete
create index if not exists idx_tag_library_name_lower
  on public.tag_library (lower(name));

-- ─── Auto-sync trigger ──────────────────────────────────────────────
-- Whenever a deal's tags array is set/updated, ensure each tag exists
-- in tag_library. SECURITY DEFINER so VA users can also drive the
-- library through normal deal edits without needing direct insert
-- privilege.
create or replace function public.sync_tag_library()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.tags is not null and array_length(NEW.tags, 1) > 0 then
    insert into public.tag_library (name)
    select distinct unnest(NEW.tags)
    on conflict (name) do nothing;
  end if;
  return NEW;
end;
$$;

drop trigger if exists tg_sync_tag_library on public.deals;
create trigger tg_sync_tag_library
  after insert or update of tags on public.deals
  for each row
  execute function public.sync_tag_library();

-- ─── Backfill from existing deal tags ───────────────────────────────
insert into public.tag_library (name)
select distinct unnest(tags)
from public.deals
where tags is not null
  and array_length(tags, 1) > 0
on conflict (name) do nothing;

comment on table public.tag_library is 'Persistent tag vocabulary. Auto-populated by tg_sync_tag_library when tags are added to deals; not removed when a tag is taken off all deals (so autocomplete stays useful).';
