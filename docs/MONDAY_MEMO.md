# Monday Memo — weekly executive briefing

The strategic layer. Every Monday morning Nathan + Justin get one email that reads like a smart COO has reviewed the past week and is telling them what matters. Pulls from GitHub commits, DCC's live data, and (when populated) team communications summaries. Claude Opus 4.5 writes the prose.

## What you actually get every Monday

**Email** to `nathan@fundlocators.com` + `justin@fundlocators.com` from `RefundLocators <hello@fundlocators.com>`. Subject:

> Monday Memo — April 27, 2026

Dark-themed HTML email (navy `#0b1222` background, gold `#d8b560` accent — different from morning-sweep's cream card on purpose, signals "strategic, not operational"). Header shows:

- "Executive Business Summary"
- Date
- Three pill stats: commits this week · active cases · messages sent · new leads (if any)

Body is a Claude-written memo with **six fixed sections**:

| Section | Purpose | Length |
|---|---|---|
| **RECOMMENDATION** | Single most important thing to do this week. Punchy paragraph. | 1 paragraph |
| **WHAT SHIPPED THIS WEEK** | GitHub commits translated to plain-English business wins, grouped by system. Skips trivial commits. | 3-6 bullets |
| **BUSINESS PULSE** | Live data interpretation: pipeline, outreach volume, lead flow, anything notable from team comms. | 3-5 sentences |
| **RELEVANT AI & TECH THIS WEEK** | 3-5 specific tools/platforms/AI developments grounded in this business — skip-tracing, property data, court records, voice/SMS, legal tech. Each one: what it is + why it matters here + how to use it. | 3-5 items |
| **WHAT TO BUILD NEXT** | Top 3-5 priorities ranked by business impact. Each: plain English, why it moves the needle, rough effort (days/week/month+). | 3-5 items |
| **WHAT TO STOP OR PAUSE** | Honest list of things costing time/money without ROI. Direct. | varies |
| **REVENUE IDEAS** | 2-3 specific actions feasible within 30 days. Grounded in real business data. | 2-3 items |

Total length capped at 600-800 words. Hard rule: every section has real content, no filler.

## What it pulls from

Three data sources merge into the prompt:

### 1. GitHub commits (last 7 days)

Hits `api.github.com/repos/<repo>/commits?since=<weekAgoIso>` for each repo in the hard-coded list:

```ts
const GITHUB_REPOS = [
  'TheLocatorOfFunds/deal-command-center',
];
```

**To add more repos** (e.g. ohio-intel, refundlocators-next), edit lines 24-26 of `supabase/functions/monday-memo/index.ts` and redeploy.

A `GITHUB_TOKEN` env var is optional but recommended — boosts the rate limit from 60 to 5000 requests per hour. Required when the repos are private (deal-command-center is public, but the rest are private).

Capped at 40 commits per run to stay within Claude's context.

### 2. DCC live data (last 7 days)

Six parallel queries to your Supabase:

| Query | Purpose |
|---|---|
| `deals` (excluding closed/recovered/dead) | Pipeline snapshot |
| `leads` created this week | New top-of-funnel volume |
| `outreach_queue` rows from this week | Outreach funnel state by status |
| `messages_outbound` this week | Inbound vs outbound message volume |
| `activity` last 50 events | Notable cross-deal events |
| `team_communications` for the past week | Gmail + Granola summaries (see below) |

These get aggregated into a `businessData` object that's handed to Claude.

### 3. Team communications (Gmail + Granola)

If the `team_communications` table has rows for the current week, Claude gets a "Communications context" block listing:

- Justin's emails this week (from `gmail-sync` Edge Function)
- Nathan's emails this week (same)
- Team's emails this week (same)
- Justin's meeting notes (from Granola)
- Nathan's meeting notes (from Granola)
- Team's meeting notes (from Granola)

These are pre-summarized weekly snapshots, not raw threads. They give the memo richer context — "Nathan got an email from a partner attorney offering case referrals" lands as a concrete signal.

If the table is empty (e.g. `gmail-sync` isn't running yet), this block is omitted and the memo is built from GitHub + DCC data only. Function still ships.

## How the memo gets generated

Claude **Opus 4.5** (not Sonnet — quality matters here) with this exact system prompt:

```
You are the AI product manager and strategic advisor for RefundLocators. Every Sunday night
you compile a Monday morning executive briefing for Nathan and Justin, the two co-founders.

Your job is to look at what was built this week, what's happening in the business, and give
them clear strategic direction for the week ahead — all in plain, direct language. You are
like a smart COO who has read everything that happened and is telling them what matters.

Tone: Confident, direct, no fluff. Write like a smart person talking to two smart founders.
No "it appears", no "it seems", no "I believe". No bullet soup — every bullet should carry
real information. If you reference a system name, briefly say what it does the first time.

[full section format spec follows — see source for exact wording]

Hard rules:
- Total length: 600-800 words
- Every section must have real content — never leave a section with filler
- If commits are sparse, say so honestly and focus on what the business needs
- Specific numbers always beat vague descriptions
```

The user message is the full JSON of `businessContext` (company description) + `businessData` (the week's numbers) + the optional communications block.

If Anthropic API errors, the memo body becomes a literal error message: `[Claude unavailable: <error>]`. The email still goes out — just with an honest failure note instead of fake content.

## What runs in what order

1. Pull commits from each GitHub repo (skip repos that 404 or rate-limit)
2. In parallel: pull deals, leads, outreach_queue, messages_outbound, activity, team_communications
3. Aggregate counts (outreach by status, messages by direction, deals by status)
4. Build `commsBlock` from team_communications if any rows exist
5. Send the system prompt + user JSON + comms block to Claude Opus 4.5
6. Render markdown → HTML (find-replace, no full parser)
7. Build the dark-themed HTML email with header pills + memo body
8. Send via Resend to `nathan@fundlocators.com` + `justin@fundlocators.com`
9. Return JSON: email_sent, commits_pulled, active_deals, new_leads, memo_preview

## Schedule

Cron: weekly at **07:00 UTC Sunday** (3am EDT / 2am EST) — yes, **Sunday at 3am**, despite the name "Monday Memo." That's intentional: the email is meant to land in your inbox before you wake up Monday morning. Cron expression: `0 7 * * 0`.

The cron is set up in the same migration that wires `morning-sweep`: `supabase/migrations/20260424120000_morning_sweep_cron.sql`.

To change the schedule:
```sql
update cron.job set schedule = '0 12 * * 1' where jobname = 'monday-memo';  -- example: Monday 8am EDT instead
```

To pause:
```sql
update cron.job set active = false where jobname = 'monday-memo';
```

## Required secrets

In Supabase Dashboard → Project Settings → Edge Functions → Secrets:

| Secret | Required | Purpose |
|---|---|---|
| `MONDAY_MEMO_SECRET` | Yes | Shared-secret authentication (cron sends this in `X-Monday-Memo-Secret` header) |
| `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | Yes (auto) | DB access |
| `ANTHROPIC_API_KEY` | Yes | Required — without it, memo body is just an error message |
| `GITHUB_TOKEN` | Recommended | Boosts rate limit + required for private repos. Personal access token with `repo:read` scope. |
| `RESEND_API_KEY` | Yes (or Vault) | Email send. Falls back to `vault.decrypted_secrets` named `resend_api_key`. |

## Smoke test (run it once manually)

```bash
curl -X POST https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/monday-memo \
  -H "X-Monday-Memo-Secret: <your hex>" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Response:
```json
{
  "email_sent": true,
  "commits_pulled": 23,
  "active_deals": 11,
  "new_leads": 3,
  "memo_preview": "## RECOMMENDATION\nFocus this week on..."
}
```

## How to change the recipient list

Edit line 20 of `supabase/functions/monday-memo/index.ts`:

```ts
const DIGEST_EMAILS = ['nathan@fundlocators.com', 'justin@fundlocators.com'];
```

Redeploy: `supabase functions deploy monday-memo --no-verify-jwt --project-ref rcfaashkfpurkvtmsmeb`.

## How to change which sections appear

The 6 fixed sections (RECOMMENDATION, WHAT SHIPPED, BUSINESS PULSE, RELEVANT AI & TECH, WHAT TO BUILD NEXT, WHAT TO STOP OR PAUSE, REVENUE IDEAS) are hard-coded into the system prompt at lines 143-187 of `index.ts`. To add or rename:

1. Add the section name + description to the FORMAT block in the system prompt
2. The HTML renderer's regex `^## ([A-Z &]+)$` matches uppercase-only headings — if your new section name has lowercase letters or special chars, update that regex on line 243

## Cost per run

| Component | Cost |
|---|---|
| Claude Opus 4.5 (1 call, ~5-10K tokens, big output) | ~$0.30-0.60 |
| GitHub API | free |
| Resend email | free under cap |
| Supabase queries | free |
| **Per run** | **~$0.30-0.60** |
| **Annual total (52 weeks)** | **~$15-30** |

Trivial.

## Why Opus, not Sonnet

The morning-sweep uses Sonnet because the briefing needs to be fast and the structure is rigid. The Monday Memo uses Opus because:
- It's once a week (cost differential is noise)
- The "strategic AI product manager" persona needs taste — picking the right 3 tools to mention, prioritizing the right 3 things to build
- Sonnet's "WHAT TO STOP OR PAUSE" sections in early tests were too soft. Opus is willing to say "kill X."

If you ever need to cost-cut, swap to Sonnet by changing `model: 'claude-opus-4-5'` to `'claude-sonnet-4-5'` on line 217.

## Related

- **`morning-sweep`** — daily 8am operational digest, different audience (you specifically, not strategic-team-of-two). See `docs/MORNING_SWEEP.md`.
- **`gmail-sync`** — populates `team_communications` table that this memo reads. Should run Saturday night to be ready for the Sunday-night memo.
- **Cron registration** — `supabase/migrations/20260424120000_morning_sweep_cron.sql`
- **Source** — `supabase/functions/monday-memo/index.ts`
