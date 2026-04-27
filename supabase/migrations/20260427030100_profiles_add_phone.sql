-- Add missing 'phone' column to profiles.
--
-- The Account Settings modal saveProfile() writes display_name + phone, but
-- the original account_settings_avatars_presence migration (20260427010000)
-- shipped without the phone column. Surfaced by Eric: "Could not find the
-- 'phone' column of 'profiles' in the schema cache" on Save profile.
--
-- The self-update RLS policy already covers it (its comment names phone as
-- intended scope), so no policy change needed.

alter table public.profiles
  add column if not exists phone text;
