# lauren-daily-review

Cron-driven Edge Function that AI-reviews yesterday's Lauren
conversations and emails Nathan a digest of anything worth seeing.

The keyword watchlist in `lauren-event-router` only catches patterns
we already know. This function catches what we don't — novel
prompt-injection attempts, social engineering, and high-signal
conversations the watchlist missed.

Justin's hardening doc Task 7.

## How it works

```
pg_cron (daily, 13:00 UTC = 9am EDT / 8am EST)
  ↓
lauren_daily_review_dispatch() (Vault secret in header)
  ↓
lauren-daily-review Edge Function
  ↓ pulls last 24h from lauren_conversations
  ↓ sends compact summary to Claude Sonnet
  ↓ Claude returns JSON: { summary, flagged[], trends[] }
  ↓
Resend → nathan@fundlocators.com
```

## Cost

~$0.05/day at 100 conversations/day, claude-sonnet-4-5. Trivial.

## Deploy

```
supabase functions deploy lauren-daily-review --project-ref rcfaashkfpurkvtmsmeb --no-verify-jwt
```

Then run migration `20260430230001_lauren_daily_review_cron.sql` to
set up the cron job + Vault secret reference.

## Required Vault secrets

- `lauren_daily_review_secret` — random 32+ char string. The cron
  function uses this; the Edge Function checks it on the
  `X-Lauren-Daily-Review-Secret` header.
- `resend_api_key` — already exists.

## Required env vars (set in Supabase Edge Function dashboard)

- `LAUREN_DAILY_REVIEW_SECRET` = same value as the Vault secret.
- `ANTHROPIC_API_KEY` — already exists for `lauren-chat`.

## Smoke test

```
curl -X POST https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/lauren-daily-review \
  -H "X-Lauren-Daily-Review-Secret: <secret>" \
  -H "Content-Type: application/json"
```

Expect `{"sent": true, "conversations_reviewed": N, "flagged_count": N}`
and an email at nathan@fundlocators.com.

## Changing the schedule

Edit the migration. Default is `0 13 * * *` (13:00 UTC). Adjust as
needed; there's no harm in running multiple times per day other than
inbox volume + Anthropic spend.
