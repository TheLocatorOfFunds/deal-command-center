# Morning Sweep — daily 8am EDT briefing

The email + SMS that lands in Nathan's inbox every morning at 8am EDT. Walks every active deal, detects overnight activity, refreshes Claude's case summary on changed deals, compiles a cross-deal briefing, and sends a short SMS to Nathan's phone + a full HTML email to nathan@fundlocators.com + justin@fundlocators.com.

## What you actually get every morning

**SMS** to `+15135162306` (Nathan's iPhone). Short — just the headline:

> 🌅 Mon, Apr 27 morning digest · 3 need attention (Smith, Jones, Williams) · 7 active quiet · 4 late-stage · full brief in email.

**Email** at `nathan@fundlocators.com` + `justin@fundlocators.com`. Subject:

> 🌅 DCC Morning Digest · Mon, Apr 27 · 3 needing attention

Body has three sections:

| Section | What's in it | When it appears |
|---|---|---|
| 🔔 **Needs your attention today** | Per-deal block: 1-3 facts about overnight activity + 1-2 concrete next actions. If a deal has pending AI-drafted SMS in `outreach_queue` awaiting your approval, those are flagged first. | Only deals with overnight activity OR pending drafts |
| 📅 **Active cases · quiet overnight** | One line each: name · stage · tier | All non-late-stage deals with no overnight activity |
| 💤 **Late-stage · waiting on court** | One line each: name · stage · days since filed | Late-stage deals (filed/awaiting-distribution/probate/paid-out) with no overnight activity |

If nothing happened overnight at all: `"Quiet morning — no overnight activity across N active cases."` and skip to the quiet lists.

## The signals it watches per deal

For each active deal, in the last 24 hours, it looks at:

| Source | What counts as activity |
|---|---|
| `messages_outbound` | Any inbound SMS reply OR outbound message sent |
| `call_logs` | Any inbound, missed, no-answer, or busy call |
| `emails` | Any inbound or outbound email |
| `docket_events` (non-backfill only) | New docket activity scraped overnight |
| `deal_notes` | Any note created or edited |
| `activity` | Any audit-log event |
| `outreach_queue` | Pending drafts in `queued`, `generating`, or `pending` status whose `scheduled_for <= now()` |

## Scope rules (Nathan-approved 2026-04-24)

| State of the deal | Bucket |
|---|---|
| Status NOT in `closed`/`recovered`/`dead` AND has overnight activity OR pending drafts | **Attention** (full detail) |
| Active (early-stage), no overnight activity | **Active quiet** (compact line) |
| Late-stage (`filed`/`awaiting-distribution`/`probate`/`paid-out`), no overnight activity | **Late-stage waiting** (one-liner) |
| `closed`/`recovered`/`dead` | Excluded entirely |

Late-stage deals don't spam the digest every day just because they're still open — they only show up as a one-liner with "days since filed."

## How the prose gets generated

Claude Sonnet 4.5 writes the briefing using this exact system prompt:

```
You are writing Nathan's daily morning briefing on his foreclosure recovery business.
Output Markdown with this exact structure:

**Top of your morning** — one sentence on what matters most today.

### 🔔 Needs your attention today
For each deal with overnight activity, one block:
- **[Client Name]** · [status] · [tier]
  - What happened (1-3 concrete facts — who messaged, what the attorney said, what court action, etc.)
  - What to do (1-2 concrete next actions — "reply to Russ Cope", "open Casey's thread", "log judgment update")
Facts + actions only. No hedging. No filler. Money amounts when you know them. Tag time-sensitive items with ⏰.

If a deal has pending_drafts, note them first in that deal's block — "📝 N AI draft(s) awaiting your review (day-X cadence)". Those are the highest-priority touch because they're one tap from sending.

### 📅 Active cases · quiet overnight
One line each, most-recent-stage first. Just: name · stage · tier.

### 💤 Late-stage · waiting on court
One line each. Name · stage · days since filed. No commentary.

Hard rules: no "I believe", no "it appears", no preamble, no meta-commentary.
If there's no attention section (no overnight activity), open with
"Quiet morning — no overnight activity across N active cases" and skip to the quiet lists.
```

The user message it gets is the full JSON of `digestContext` — counts, every attention deal's overnight summary, every quiet deal's status snapshot.

If Claude is unavailable (no `ANTHROPIC_API_KEY` or API errors), there's a fallback that writes a plainer markdown version from the same data — function still ships an email, just without the prose polish.

## What runs in what order

1. Pull all active deals (status NOT IN `closed`/`recovered`/`dead`)
2. Pull `outreach_queue` rows that are `queued`/`generating`/`pending` and `scheduled_for <= now()`
3. For each deal, parallel-fetch the 6 activity sources for the last 24h
4. Bucket each deal as `attention` / `active_quiet` / `late_quiet`
5. **For every "attention" deal: refresh its AI case summary** by calling the `generate-case-summary` Edge Function. This is why the digest also keeps each deal's case summary fresh — DCC's UI reads that summary in deal detail panels.
6. Compose the JSON context, ask Claude for the briefing prose
7. Build the SMS body (≤320 chars, headline only)
8. Send SMS via Twilio (currently on, but the Twilio path is legacy — see "Outbound SMS gotcha" below)
9. Render the markdown to HTML (light find-replace, not a full markdown parser) wrapped in a cream-card design
10. Send the email via Resend to `nathan@fundlocators.com` + `justin@fundlocators.com` from `RefundLocators <hello@refundlocators.com>`
11. Return JSON: counts, refreshed count, sms_sent, email_sent, digest preview

## Schedule

Cron: daily at **12:00 UTC** (8am EDT / 7am EST) via `pg_cron` job set up in migration `20260424120000_morning_sweep_cron.sql`. The cron calls this Edge Function with the `X-Morning-Sweep-Secret` header from Vault.

To change the schedule:
```sql
update cron.job set schedule = '0 13 * * *' where jobname = 'morning-sweep';  -- example: 9am EDT
```

To pause:
```sql
update cron.job set active = false where jobname = 'morning-sweep';
```

## Required secrets

In Supabase Dashboard → Project Settings → Edge Functions → Secrets:

| Secret | Required | Purpose |
|---|---|---|
| `MORNING_SWEEP_SECRET` | Yes | Shared-secret authentication (cron sends this in `X-Morning-Sweep-Secret` header) |
| `SUPABASE_URL` | Yes (auto) | Points the function at our project |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes (auto) | Lets the function read all tables bypassing RLS |
| `ANTHROPIC_API_KEY` | Recommended | Claude Sonnet 4.5 writes the prose. Without it, falls back to a plainer markdown version. |
| `RESEND_API_KEY` | Yes (or Vault) | Email send. Function looks at env var first, then falls back to `vault.decrypted_secrets` named `resend_api_key`. |
| `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` + `TWILIO_FROM_NUMBER` | Optional | Sends the short SMS. If unset, just emails. |

## Outbound SMS gotcha

Per CLAUDE.md: **all outbound SMS in DCC goes through Nathan's iPhone via the mac_bridge, not Twilio.** The morning-sweep function still has Twilio code in it — that's legacy and should be migrated to use the same `send-sms` Edge Function pattern that DCC's outreach uses (which routes to `gateway = 'mac_bridge'`).

Right now if Twilio creds aren't set, the SMS just doesn't send — function still emails. That's the safest posture until someone migrates the SMS path.

**Cleanup task (separate session):** rip out the inline Twilio call (lines 254-263 of `index.ts`), call DCC's `send-sms` Edge Function instead, let the mac_bridge gateway handle delivery. Bounded ~30 min.

## Smoke test (run it once manually)

```bash
curl -X POST https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/morning-sweep \
  -H "X-Morning-Sweep-Secret: <your hex>" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Response shape:
```json
{
  "deals_total": 11,
  "deals_attention": 3,
  "deals_active_quiet": 4,
  "deals_late_quiet": 4,
  "deals_refreshed": 3,
  "pending_drafts": 2,
  "sms_sent": false,
  "email_sent": true,
  "digest_preview": "**Top of your morning** — Casey Jennings's attorney filed a..."
}
```

## How to change the recipient list

Edit lines 24-25 of `supabase/functions/morning-sweep/index.ts`:

```ts
const NATHAN_PHONE = '+15135162306';
const DIGEST_EMAILS = ['nathan@fundlocators.com', 'justin@fundlocators.com'];
```

Then redeploy: `supabase functions deploy morning-sweep --no-verify-jwt --project-ref rcfaashkfpurkvtmsmeb`

## How to change which sections appear

Section logic is hard-coded into the system prompt (see "How the prose gets generated"). To add a new section (e.g. "Money this week" pulling from `expenses` or `payments`), you'd:

1. Add the data source to the parallel-fetch in step 3
2. Add it to `digestContext` in step 6
3. Update the system prompt with the new section name + format
4. Update the fallback markdown in lines 220-240 if you want fallback parity

## Cost per run

| Component | Cost |
|---|---|
| Claude Sonnet 4.5 (1 call, ~3-5K tokens) | ~$0.02-0.04 |
| `generate-case-summary` calls (one per attention deal, varies) | ~$0.01-0.02 each |
| Resend email (2 recipients) | ~free under monthly cap |
| Twilio SMS (if active) | ~$0.008 per send |
| Supabase queries | free |
| **Daily total** | **~$0.05-0.20** |
| **Annual total** | **~$20-75** |

Rounding errors. Worth it.

## Related

- **`monday-memo`** — weekly Sunday memo, separate strategic layer. See `docs/MONDAY_MEMO.md`.
- **`castle-health-daily`** — daily scraper health alert, fires on issues only. See `docs/archive/SETUP_CASTLE_HEALTH_DAILY.md`.
- **Cron registration** — `supabase/migrations/20260424120000_morning_sweep_cron.sql`
- **Source** — `supabase/functions/morning-sweep/index.ts`
