-- Operational record: created `intel_sync_secret` in vault on 2026-04-28.
-- The actual value is managed in vault (and in the EF env), never in git.
--
-- This file is a no-op on replay. The secret was created/rotated by a
-- transient write that put `vault.create_secret(VALUE, ...)` into this
-- file with the literal value, applied via `supabase db push`, and then
-- this sanitized version was written back over it before any git add.
--
-- To rotate the secret:
--   1. New value: `openssl rand -hex 32 > ~/.intel-sync-secret`
--   2. Update EF env: `supabase secrets set INTEL_SYNC_SECRET="$(cat ~/.intel-sync-secret)"`
--   3. Update vault: same temporary-migration-then-sanitize trick, OR run
--      `select vault.update_secret(id, '<new>', 'intel_sync_secret')`
--      via direct DB connection.

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'intel_sync_secret') then
    raise notice 'intel_sync_secret missing from vault — set it manually before cron will work';
  end if;
end $$;
