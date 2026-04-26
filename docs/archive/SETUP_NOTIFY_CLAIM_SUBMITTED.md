# Setup — Notify Claim Submitted

Closes Castle's Bug #1: every personalized-link claim modal submission was silently failing because `personalized_links.claim_submitted_at` and `mailing_address` columns didn't exist. Adds them + a trigger that texts/emails Nathan whenever a claim lands.

5 manual steps. ~5 min.

## 1. Generate a shared secret

```bash
openssl rand -hex 32
```
Copy the output.

## 2. Set Edge Function secrets

Supabase Dashboard → Project Settings → Edge Functions → Secrets:
- **`NOTIFY_CLAIM_SUBMITTED_SECRET`** = (hex from step 1)

These should already be set; verify they exist:
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`
- `RESEND_API_KEY`
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (auto)

## 3. Deploy the Edge Function

Dashboard → Edge Functions → Deploy a new function → **Via Editor**:
- Name: `notify-claim-submitted`
- Verify JWT: **OFF**
- Code: paste contents of [`supabase/functions/notify-claim-submitted/index.ts`](https://raw.githubusercontent.com/TheLocatorOfFunds/deal-command-center/main/supabase/functions/notify-claim-submitted/index.ts)

## 4. Store the secret in Vault

Dashboard → Database → Vault → Add new secret:
- Name: `notify_claim_submitted_secret`
- Secret: (same hex from step 1)

## 5. Apply the migration

Supabase SQL Editor: https://supabase.com/dashboard/project/rcfaashkfpurkvtmsmeb/sql/new

Paste the contents of `supabase/migrations/20260425000000_personalized_links_claim_columns.sql` and run.

This:
- Adds `personalized_links.mailing_address` + `personalized_links.claim_submitted_at`
- Creates `notify_personalized_claim_submitted()` trigger function
- Wires the trigger to fire on `personalized_links` UPDATE when `claim_submitted_at` flips NULL → NOT NULL

## Smoke test

Pick any of tonight's 19 personalized-link tokens. Hit `https://refundlocators.com/s/<token>` on a phone, submit the claim modal with placeholder data.

Within ~5 seconds you should see:
1. **SMS to Nathan** at +1 513-516-2306 starting with `🎯 PERSONALIZED CLAIM from <name>`
2. **Email to nathan@fundlocators.com** with the full claim details + "Open in DCC →" link
3. SQL: `select claim_submitted_at, mailing_address from personalized_links where token = '<token>';` returns timestamps + address

If SMS + email don't arrive but the column populates, check Edge Function logs at:
https://supabase.com/dashboard/project/rcfaashkfpurkvtmsmeb/functions/notify-claim-submitted/logs

Most likely cause if it doesn't fire: the secret in Vault doesn't match the secret on the Edge Function.

## Manual test without using a real token

```bash
curl -X POST https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/notify-claim-submitted \
  -H "X-Notify-Claim-Submitted-Secret: <your hex>" \
  -H "Content-Type: application/json" \
  -d '{"token": "<an existing personalized_links.token>"}'
```

Returns `{"sms_sent": true, "email_sent": true, "deal_id": "..."}` on success.

## What this DOESN'T fix (marketing-site session owns)

The front-end at `refundlocators-next/src/app/s/[token]/PersonalizedClient.tsx` line 469-471 still has a `try/catch` that swallows fetch errors and advances to the "done" screen regardless. After this migration lands, real submissions will succeed (no more 500), but if the API ever returns an error in the future, the user will still see "done" while Nathan gets nothing. The marketing-site Claude session needs to add `if (!res.ok) throw new Error(...)` and surface server errors to the user. Out of scope for DCC.
