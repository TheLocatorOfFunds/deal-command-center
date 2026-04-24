# Setup — Castle Health Daily ("agent-on-cron")

Runs every day at 13:00 UTC (9am EDT / 8am EST). Reads `v_scraper_health`,
compares with the last 7 days of snapshots in `castle_health_log` to detect
chronic vs transient issues, asks Claude for a human summary + recommended
actions, always logs the snapshot, and emails the recipient ONLY when there
are issues. Silent on green days — no inbox spam.

5 manual steps. ~5 min total.

## 1. Generate a shared secret

```bash
openssl rand -hex 32
```
Copy the output.

## 2. Set Edge Function secrets

Supabase Dashboard → Project Settings → Edge Functions → Secrets:

- **`CASTLE_HEALTH_DAILY_SECRET`** = (hex from step 1)
- **`CASTLE_HEALTH_RECIPIENT`** = where alerts go. Default: `nathan@fundlocators.com`.
  Change this anytime without redeploying. Suggested: an ops alias once Justin
  confirms his real mailbox, e.g. `justin@fundlocators.com`.

These should already be set, but verify:
- `ANTHROPIC_API_KEY` (used for the AI summary call — claude-sonnet-4-5)
- `RESEND_API_KEY` (used for the email)
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (auto)

## 3. Deploy the Edge Function

```bash
cd ~/Documents/Claude/deal-command-center
supabase functions deploy castle-health-daily --no-verify-jwt --project-ref rcfaashkfpurkvtmsmeb
```

Or via Dashboard → Edge Functions → upload from `supabase/functions/castle-health-daily/index.ts`.

## 4. Store the secret in Vault (so the cron can call the function)

Supabase Dashboard → Database → Vault → New Secret:
- Name: `castle_health_daily_secret`
- Secret: (same hex from step 1)

## 5. Apply the migration

Supabase SQL Editor: https://supabase.com/dashboard/project/rcfaashkfpurkvtmsmeb/sql/new

Paste the contents of `supabase/migrations/20260424220000_castle_health_daily.sql` and run.

This creates the `castle_health_log` table and schedules the
`castle-health-daily` cron job at 13:00 UTC.

## Smoke test (run it once manually)

```bash
curl -X POST https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/castle-health-daily \
  -H "X-Castle-Health-Daily-Secret: <your hex>" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Expected response on a green day:
```json
{
  "severity": "green",
  "agents_checked": 5,
  "issues_found": [],
  "email_sent": false,
  "log_id": "...",
  "recipient": null
}
```

Expected response when court_pull is yellow (your current state):
```json
{
  "severity": "transient",
  "agents_checked": 5,
  "issues_found": [{ "agent": "court_pull", "color": "yellow", "age_min": 111 }],
  "email_sent": true,
  "log_id": "...",
  "recipient": "nathan@fundlocators.com"
}
```

The recipient gets an HTML email with:
- 🟡 / 🔴 / ⚠ severity badge in the header
- A 1–2 sentence summary from Claude (e.g. "court_pull poller hasn't claimed
  a request in 111 min and has 1 failure in the last 3h. Daemon likely stuck.")
- The full agent table with health dots
- Recommended actions ranked high/med/low priority

## Verify the snapshot was logged

```sql
select snapshot_at, severity, summary, email_sent, email_recipient
from public.castle_health_log
order by snapshot_at desc limit 5;
```

## Severity rules (deterministic, computed BEFORE Claude is called)

| Today's state                                          | Severity   | Email? |
|-------------------------------------------------------|------------|--------|
| All enabled agents green                               | `green`    | No     |
| 1+ yellow today, was green most of last 3 days        | `transient`| Yes (FYI) |
| 1+ yellow today AND yellow 2+ of last 3 days          | `chronic`  | Yes (action) |
| 1+ red OR enabled-never_run                           | `critical` | Yes (URGENT) |

Claude only writes the prose. It cannot upgrade or downgrade the severity.

## To change the recipient

Just update the `CASTLE_HEALTH_RECIPIENT` secret in the Edge Function Secrets.
No redeploy needed — Deno re-reads env vars per cold start, and Supabase
typically cycles the function within an hour.

## To pause it

```sql
update cron.job set active = false where jobname = 'castle-health-daily';
```
Reactivate with `active = true`.

## To run it more / less frequently

Edit the schedule in the migration (currently `'0 13 * * *'` = daily 13:00 UTC).
For weekdays only: `'0 13 * * 1-5'`. For twice a day: `'0 13,21 * * *'`.
Then re-apply the migration.

## Cost

Per run: ~1 Claude call (claude-sonnet-4-5, ~500 input tokens, ~300 output) ≈ $0.003.
Per year: ~$1. Plus 1 Resend email per issue day. Trivial.
