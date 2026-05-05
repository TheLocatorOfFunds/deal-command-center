-- ─────────────────────────────────────────────────────────────────
-- 20260430230001_lauren_daily_review_cron
--
-- Schedules pg_cron to call lauren-daily-review once per day.
-- Runs at 13:00 UTC = 9am EDT / 8am EST. Nathan gets the digest
-- in his inbox alongside the morning-sweep + castle-health-daily.
--
-- Required Vault secret (set BEFORE running this migration):
--   INSERT INTO vault.secrets (name, secret)
--     VALUES ('lauren_daily_review_secret', '<random 32+ char string>');
-- ─────────────────────────────────────────────────────────────────

SELECT cron.schedule(
  'lauren-daily-review',
  '0 13 * * *',
  $$
    select
      net.http_post(
        url := 'https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/lauren-daily-review',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'X-Lauren-Daily-Review-Secret',
            (select decrypted_secret from vault.decrypted_secrets where name = 'lauren_daily_review_secret' limit 1)
        ),
        body := '{}'::jsonb
      );
  $$
);
