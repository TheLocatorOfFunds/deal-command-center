# Setup — Morning Sweep

Three manual steps Nathan (or a fresh session with live MCP auth) needs to do
to activate the morning sweep. My session's Supabase auth token expired
mid-build, so I couldn't deploy directly.

## 1. Generate a shared secret

In terminal:
```bash
openssl rand -hex 32
```
Copy the output. You'll paste it in two places.

## 2. Set the Edge Function secret

Supabase Dashboard → Project Settings → Edge Functions → Secrets:
- Name: `MORNING_SWEEP_SECRET`
- Value: (the hex string you just generated)

Save.

## 3. Deploy the Edge Function

Via Supabase CLI:
```bash
cd ~/Documents/Claude/deal-command-center
supabase functions deploy morning-sweep --no-verify-jwt --project-ref rcfaashkfpurkvtmsmeb
```

Or via the Supabase Dashboard → Edge Functions → morning-sweep → deploy from
the file at `supabase/functions/morning-sweep/index.ts`.

## 4. Store the secret in Vault (for pg_cron to read)

Supabase Dashboard → Database → Vault → New Secret:
- Name: `morning_sweep_secret`
- Secret: (same hex string from step 1)

Save.

## 5. Apply the migration

In Supabase Dashboard → SQL Editor, paste the contents of:
```
supabase/migrations/20260424120000_morning_sweep_cron.sql
```
Run it. This schedules `morning-sweep-daily` at 12:00 UTC (8am EDT / 7am EST).

## 6. Smoke test

Manually invoke the Edge Function right now to confirm:
```bash
curl -X POST https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/morning-sweep \
  -H "X-Morning-Sweep-Secret: <your hex string>"
```

You should get JSON like:
```json
{
  "deals_total": 22,
  "deals_attention": 3,
  "deals_active_quiet": 8,
  "deals_late_quiet": 11,
  "deals_refreshed": 3,
  "sms_sent": true,
  "email_sent": true,
  "digest_preview": "..."
}
```

And within ~60 seconds you should receive:
- An SMS to +15135162306
- An email to nathan@fundlocators.com

## 7. Verify the cron is scheduled

In SQL editor:
```sql
select jobname, schedule, command from cron.job where jobname = 'morning-sweep-daily';
```

Should show the row with schedule `0 12 * * *`.

## What happens daily

1. **12:00 UTC (8am EDT / 7am EST)** — pg_cron fires
2. pg_net POSTs to `morning-sweep` Edge Function with the shared secret
3. Function walks all active deals, classifies them:
   - **attention** — had any change in last 24h
   - **active_quiet** — active (not late-stage) but no overnight change
   - **late_quiet** — late-stage (filed / awaiting-distribution / probate / paid-out) with no overnight change
4. For each `attention` deal → refreshes the AI case summary via
   `generate-case-summary`
5. Compiles a Claude briefing with 3 sections:
   - 🔔 **Needs your attention today** (full detail per deal)
   - 📅 **Active cases · quiet overnight** (one-liner each)
   - 💤 **Late-stage · waiting on court** (one-liner with days-since-filed)
6. Sends SMS summary + full email via Resend

## Cost

- ~1 Claude call for the digest + 1 Claude call per attention deal (typically
  0-5/day) ≈ $0.05-0.20/day
- ~1 Twilio SMS (≈ $0.01)
- ~1 Resend email (free tier)
- Daily max: ~$0.25
- Monthly: ~$7.50

## To change the schedule

Run in SQL Editor:
```sql
select cron.alter_job(
  (select jobid from cron.job where jobname = 'morning-sweep-daily'),
  schedule := '0 11 * * *'  -- 11 UTC = 7am EDT / 6am EST
);
```

## To disable temporarily

```sql
select cron.unschedule('morning-sweep-daily');
```

## To re-enable

Re-run the migration SQL.

## Lauren-phase-3 follow-up (not built)

Per the Lauren Agent Charter + the earlier conversation:
- Autonomous replies are explicitly gated behind Lauren's playbook being
  written + first-50-supervised cycle
- Today's digest highlights "needs attention" items; tomorrow's version
  (Phase 3) will auto-draft reply SMS/email bodies for each attention item
  and queue them in a human-review tab in DCC
- Once Nathan reviews 50 drafts with ≥ 90% untouched-approval rate on a
  per-tier basis, that tier's drafts auto-send and the digest says "I
  handled these" instead of "you need to handle these"

That's the roadmap. Morning sweep is the foundation.
