# Audit: `public.send_daily_digest()` — possibly dead code

**Audited 2026-04-27.** This pg function is referenced in `CLAUDE.md` as the daily 8am digest, but the more-recent `morning-sweep` Edge Function fires at the same time and does a richer version of the same job. Likely an obsolete predecessor that's still scheduled and silently sending duplicate emails — or already disabled and we just need to clean up the references.

## Why this audit exists

`CLAUDE.md` line 94:

> **Daily digest**: `public.send_daily_digest()` runs at 12:00 UTC (8am EDT / 7am EST) via pg_cron job `daily-digest-nathan`. Queries stale deals, urgent deadlines, unfiled surplus, bonuses owed, portal activity, monthly metrics — builds an HTML email and sends via Resend.

But the `morning-sweep` Edge Function ALSO runs at 12:00 UTC (also 8am EDT) via pg_cron job `morning-sweep`. Two cron jobs hitting Nathan's inbox at the exact same minute is one too many.

## What the audit found

### Finding 1 — `send_daily_digest()` exists in the live DB but its CREATE migration is missing from git

```bash
$ grep -rl "create.*function.*send_daily_digest" supabase/migrations/
# (no results — no CREATE migration in git)

$ grep -rl "send_daily_digest" supabase/migrations/
supabase/migrations/20260422020647_fix_team_email_recipient_to_fundlocators.sql
```

The 2026-04-22 migration **modifies** the function's source (find-replace on the email recipient) but the original CREATE was done via the Supabase SQL Editor and never committed. This is schema-drift — the live DB has a function the repo doesn't.

### Finding 2 — pg_cron job `daily-digest-nathan` was never registered via a migration in git either

```bash
$ grep -rl "daily-digest-nathan\|cron.schedule.*send_daily" supabase/migrations/
# (no results)
```

Same drift problem. The cron job is referenced in CLAUDE.md but the `cron.schedule()` call doesn't exist in any migration. It was scheduled directly in SQL Editor.

### Finding 3 — `morning-sweep` is more capable than `send_daily_digest`

Per CLAUDE.md, `send_daily_digest` queries:
- stale deals
- urgent deadlines
- unfiled surplus
- bonuses owed
- portal activity
- monthly metrics

`morning-sweep` queries:
- every active deal
- last 24h of: messages, calls, emails, docket events, deal notes, activity log
- pending outreach drafts
- + Claude writes natural-language briefing
- + refreshes per-deal AI case summaries on changed deals

Different scope. `morning-sweep` is operational ("here's what happened overnight, here's what to do today"). `send_daily_digest` was probably more aggregate metrics. Both at 8am is overlap by timing, not by content.

## What you should do

Three steps. Each is small and safe.

### Step 1 — Verify which crons are actually firing

In Supabase SQL Editor on project `rcfaashkfpurkvtmsmeb`:

```sql
select jobid, jobname, schedule, command, active
from cron.job
where jobname ilike '%digest%' or jobname ilike '%sweep%' or command ilike '%send_daily_digest%'
order by jobname;
```

Likely outcomes:
- `daily-digest-nathan` is `active = true` → it's still firing duplicate emails. **Disable it** (Step 2).
- `daily-digest-nathan` is `active = false` → already disabled, just stale CLAUDE.md reference. Skip to Step 3.
- `daily-digest-nathan` doesn't exist → already cleaned up. Skip to Step 3.

### Step 2 — Disable the legacy cron (only if Step 1 shows it active)

```sql
update cron.job set active = false where jobname = 'daily-digest-nathan';
```

This is reversible — set `active = true` to bring it back. Don't `cron.unschedule()` until you're sure you don't want it.

### Step 3 — Backfill the missing migrations + update CLAUDE.md

To stop the schema drift, export the live function definition into a real migration file:

```sql
select pg_get_functiondef('public.send_daily_digest'::regproc);
```

Copy the output, save as a new migration:

```
supabase/migrations/<timestamp>_backfill_send_daily_digest_definition.sql
```

Wrap with `create or replace function public.send_daily_digest() ...` so re-running is safe. Commit.

Then either:

| Decision | What to do |
|---|---|
| Keep `send_daily_digest()` as a different daily report (not 8am) | Move its cron to a different schedule (e.g. `0 17 * * *` for 5pm summary), update CLAUDE.md |
| Retire it (morning-sweep covers everything) | Add a migration that drops the function: `drop function if exists public.send_daily_digest();` and unschedules the cron: `select cron.unschedule('daily-digest-nathan');`. Update CLAUDE.md to remove the reference. |

**Recommended:** retire it. `morning-sweep` is the canonical daily 8am email. Keeping two pipelines that fire at the same minute is technical debt. If you want a 5pm "money report" type digest later, build it new instead of resurrecting the legacy function.

## Why this isn't auto-fixed in this session

Three reasons:

1. **Step 1 requires running a query in production** to verify state. That's a Nathan-or-Justin action, not an autonomous one.
2. **Step 2 is irreversible-feeling enough** (an email pipeline disappearing) that explicit approval is the safer path.
3. **Step 3 requires reading the live function definition** before deciding keep-vs-retire. Can't pre-write the migration without seeing the contents.

## Sequence to action this

1. Open https://supabase.com/dashboard/project/rcfaashkfpurkvtmsmeb/sql/new
2. Paste the Step 1 query, run it, screenshot or paste the result back to a Claude session
3. Based on result, follow Step 2 (if needed) and Step 3
4. After Step 3 lands, update `CLAUDE.md` to either remove the `send_daily_digest` line entirely (if retired) or fix the timing reference (if kept on a different schedule)

~15 minutes total once you start.

## Related

- `docs/MORNING_SWEEP.md` — the canonical daily 8am pipeline (the survivor in any "retire one" outcome)
- `docs/MONDAY_MEMO.md` — the weekly strategic memo (separate concern)
- `supabase/migrations/20260422020647_fix_team_email_recipient_to_fundlocators.sql` — the only existing migration that touches `send_daily_digest`, only does a find-replace on recipient
