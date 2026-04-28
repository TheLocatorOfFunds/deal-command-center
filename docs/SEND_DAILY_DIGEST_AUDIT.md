# Audit: `public.send_daily_digest()` — RETIRED 2026-04-27

**Status:** Retired by migration `20260428000000_retire_daily_digest_nathan.sql`. The pg_cron job `daily-digest-nathan` is now `active=false`. Function `public.send_daily_digest()` is left in place pending a stability window (see "Follow-up" below).

**Original audit (2026-04-27):** This pg function was referenced in `CLAUDE.md` as the daily 8am digest, but the more-recent `morning-sweep` Edge Function was firing at the same time and doing a richer version of the same job. The query against `cron.job` confirmed both were `active=true` at `0 12 * * *` — duplicate emails landing every morning at 8am EDT.

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

## Sequence to action this — DONE 2026-04-27

1. ✅ Ran the cron audit query — confirmed both jobs active at `0 12 * * *`
2. ✅ Migration `20260428000000_retire_daily_digest_nathan.sql` deactivates the legacy cron
3. ✅ `CLAUDE.md` updated to remove the `send_daily_digest` reference

## Follow-up (later — not blocking)

The `public.send_daily_digest()` function body is still in the live DB but its CREATE migration isn't in git. Two follow-up tasks worth doing eventually:

1. **Snapshot the function definition** before any drop, so we have a record:
   ```sql
   select pg_get_functiondef('public.send_daily_digest'::regproc);
   ```
   Save the output as `docs/archive/legacy_send_daily_digest_definition.sql` for forensics.

2. **After ~1 week of clean morning-sweep operation** with no need to revert, drop the function and unschedule the cron entirely:
   ```sql
   drop function if exists public.send_daily_digest();
   select cron.unschedule('daily-digest-nathan');
   ```
   Wrap that in a new migration. Reversible only by re-creating from the snapshot.

## Related

- `docs/MORNING_SWEEP.md` — the canonical daily 8am pipeline (the survivor in any "retire one" outcome)
- `docs/MONDAY_MEMO.md` — the weekly strategic memo (separate concern)
- `supabase/migrations/20260422020647_fix_team_email_recipient_to_fundlocators.sql` — the only existing migration that touches `send_daily_digest`, only does a find-replace on recipient
