-- Mobile push notification token, set by the Expo client after the user
-- grants notification permission. We send via the Expo Push Service so
-- the value here is an "ExponentPushToken[...]"-shaped string, not a raw
-- APNs token. Nullable: tokens land asynchronously and can be revoked.
alter table public.profiles
  add column if not exists expo_push_token text;

-- A given Expo push token must be unique to one user — if Justin signs
-- out of one device and into the same device as another user, the new
-- registration should overwrite the old user's token. Enforce that with
-- a partial unique index (allows multiple nulls).
create unique index if not exists profiles_expo_push_token_unique
  on public.profiles (expo_push_token)
  where expo_push_token is not null;
