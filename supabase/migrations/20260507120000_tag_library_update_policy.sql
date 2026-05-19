-- Add the missing UPDATE policy on tag_library so the 🎨 color-cycle
-- button actually works. Eric flagged 2026-05-07: clicking the palette
-- chip on any tag does nothing visible.
--
-- Root cause: when the table was created (20260504220000_tag_library.sql)
-- it got SELECT + INSERT + DELETE policies. The color column was added
-- a few hours later (20260504240000_tag_library_color.sql) but NO update
-- policy was ever added. PostgREST UPDATEs against RLS-protected tables
-- with no matching policy silently affect zero rows — `.update()` calls
-- in supabase-js return { data: null, error: null }, so the UI looked
-- like it succeeded.
--
-- This mirrors the team_write INSERT policy: admins and VAs can recolor
-- tags. Same audience that creates tags should be able to maintain them.

drop policy if exists "tag_library_team_update" on public.tag_library;
create policy "tag_library_team_update" on public.tag_library
  for update to authenticated
  using (public.is_admin() or public.is_va())
  with check (public.is_admin() or public.is_va());

comment on policy "tag_library_team_update" on public.tag_library is
  'Admins and VAs can update tag rows (used by the 🎨 color-cycle button on tag chips). Mirrors team_write INSERT policy. Added 2026-05-07 after Eric flagged the cycle button silently no-op''ing.';
