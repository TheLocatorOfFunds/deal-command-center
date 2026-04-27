-- Phase 1.5: Account settings + avatars + online presence.
--
-- Adds the bits needed to make Team Chat feel like a real chat instead of
-- colored initials: profile photos, custom display names, "active now" dot.
-- Sets up the password-login path too — magic link still works in parallel.

alter table public.profiles
  add column if not exists avatar_path text,
  add column if not exists display_name text,
  add column if not exists last_active_at timestamptz;

create index if not exists idx_profiles_active on public.profiles(last_active_at desc) where last_active_at is not null;

-- Self-update policy on profiles (so users can edit their own avatar/name/phone)
drop policy if exists profiles_self_update on public.profiles;
create policy profiles_self_update on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- Avatars bucket. Public read so any team member can see anyone's avatar
-- (cheap and avoids per-render signed URL traffic). Writes are folder-scoped
-- to user_id so nobody can overwrite someone else's photo.
insert into storage.buckets (id, name, public, file_size_limit)
  values ('avatars', 'avatars', true, 10485760)  -- 10 MB cap
  on conflict (id) do update
  set public = true,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = null;

drop policy if exists avatars_public_select on storage.objects;
create policy avatars_public_select on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'avatars');

drop policy if exists avatars_self_insert on storage.objects;
create policy avatars_self_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists avatars_self_update on storage.objects;
create policy avatars_self_update on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists avatars_self_delete on storage.objects;
create policy avatars_self_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- Presence heartbeat. Browser ticks this every 60s while DCC is open in
-- any tab. Cheap update; no triggers, no realtime publication (we read it
-- back when rendering avatars). 2-minute window = "online".
create or replace function public.touch_user_presence()
returns void
language sql
security definer
set search_path = public
as $$
  update public.profiles set last_active_at = now() where id = auth.uid();
$$;

grant execute on function public.touch_user_presence() to authenticated;

-- Convenience: backfill display_name = name for existing rows so the UI
-- has something to render even if the user never opens Account Settings.
update public.profiles
  set display_name = name
  where display_name is null and name is not null;
