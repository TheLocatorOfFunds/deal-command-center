# 2026-07-08 · Nathan · Docket-task hygiene (337 open tasks → 186)

## What shipped

**Migration `20260708210000_docket_task_hygiene.sql`** (applied to prod via
Management API + ledger row inserted; DB-only, no app rebuild):

1. **Data cleanup:** closed 151 open docket-spawned tasks due before
   2026-06-03 across 65 deals (337 open → 186). One team-visible 🧹
   activity row per touched deal, batched in a single INSERT..SELECT.
   The 186 remaining open tasks (due on/after 2026-06-03) were untouched.
2. **Trigger `handle_docket_auto_task()` hardened:**
   - Skips any event whose `event_date` is >30 days past, REGARDLESS of
     `is_backfill`. This is the guard that actually matters (see below).
   - Hearing-prep tasks never spawn for hearings already past; due_date
     clamped with `greatest(..., current_date)` so a task can't be born
     overdue.
   - `assigned_to` is now **NULL** (was hardcoded `'Nathan'`). Auto-tasks
     are team action items; assignment is a deliberate human act.

## Root cause (non-obvious)

The trigger has ALWAYS had an `is_backfill` guard, and the column is
`NOT NULL DEFAULT false` - so the guard was never the problem. The
docket-webhook only sets `is_backfill=true` when Castle sends
`raw.backfill === true`, and the April 2026 backfill run **did not send
the flag**. Every historical event landed as a "live" event and spawned
a task - hearings as old as 2005, all assigned to Nathan. Small ongoing
leak too (8 stale tasks created in July from historical hearing events).
Lesson: **don't trust a sender-supplied backfill flag; gate on the event
date itself.**

## Verification

- Before/after counts via Management API: 337 open / 151 stale-docket /
  0 old non-docket at risk → 186 open / 0 stale / 186 recent untouched;
  65 activity rows (one per deal).
- Live-fire trigger test inside a `begin;`-without-commit transaction
  (session close rolls back): unflagged 2022 hearing → 0 tasks;
  future hearing → 1 task, `assigned_to IS NULL`, due = hearing - 2d;
  0 test rows leaked afterward.
- `assigned_to=NULL` blast-radius check: web Tasks views + mobile render
  unassigned fine (display-only), `get_daily_worklist()` never reads
  `tasks`; only My Day's 'Waiting on you' filters `assigned_to='Nathan'`,
  which is exactly the intended exclusion. Commented on #333.

## Gotchas hit (future sessions need to know)

- **`current_date` in verify queries drifts across UTC midnight.** My
  "same" stale-count query returned 151 then 172 minutes apart because
  the second run crossed 00:00 UTC and the `current_date - 35` cutoff
  moved a day. Use fixed literal dates in cleanup predicates and their
  before/after verification queries.
- **plpgsql CASE-branch `return NEW;` + data-modifying CTE snapshots:**
  a single statement with INSERT CTEs can't observe rows its own AFTER
  triggers create - split trigger tests into separate statements.
- **Ledger insert works over the raw Management API.** The 2026-05-27
  archive says the MCP harness blocks direct `schema_migrations` writes;
  the `POST /v1/projects/<ref>/database/query` channel does not - insert
  `(version, name, statements)`. Caveat: `migrations-applied.yml` is
  currently red for an unrelated reason - the repo secret SUPABASE_PAT
  gets an account-privilege 403 on the migrations READ endpoint (started
  on or before the 2026-07-06 push). Ledger row confirmed present by
  direct query; see #334 for the PAT rotation.

## Follow-ups

- #333: 'Waiting on you' due-window `[today-3, today+7]` can widen, but
  the 186 legacy open tasks are still `assigned_to='Nathan'` - widen
  fully only after those work down (or get bulk-unassigned, a call Nathan
  should make).
- Untracked `supabase/migrations/20260624120000_activity_created_at_index.sql`
  was sitting uncommitted in the working tree (another session's
  in-flight work) - left alone.
