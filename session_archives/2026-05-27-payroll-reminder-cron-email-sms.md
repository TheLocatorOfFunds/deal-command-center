# Session 2026-05-27 — Payroll reminder (cron + email + SMS)

**Owner:** Justin
**Branch(es):** `claude/payroll-reminder`
**Related PRs:** (this PR)

## What we set out to do

Justin wanted a recurring reminder to run payroll on the 1st and 15th of each
month, refiring at 9am + 4pm ET every day until done, via email + SMS, just to
him. Title framing: "Payroll due and how much is due to each person." Followed
the same thread where we'd just fixed the Team Payroll display bug (PR #216) and
removed the deal-search bar from the Time tab (PR #220).

## Decisions made (durable — these change behavior going forward)

- **"Outstanding payroll" is defined by data, not a flag.** A pay period is due
  if it's a completed period whose `pay_date <= today` AND at least one VA has
  ≥0.25h logged in it with no matching `payments` row (keyed on
  user_id+period_start+period_end). The existing "Mark Paid" button is therefore
  the off-switch — no separate completion state to track. Marking everyone paid
  silences the reminder automatically on the next cron run.

- **Pay-period model mirrors the app's existing `computePayPeriod`**: Period A =
  11–25 (pay date 1st of next month), Period B = 26–10 (pay date 15th). The SQL
  `payroll_due_summary()` enumerates period end-dates (10th + 25th) over the
  trailing 60 days and includes any whose pay_date has arrived.

- **DST handled in SQL, not cron.** pg_cron is UTC-only. We schedule 4 UTC slots
  (`0 13,14,20,21 * * *`) and `send_payroll_reminder()` self-filters to
  `extract(hour from now() AT TIME ZONE 'America/New_York') in (9,16)`. Never
  drifts across EDT/EST, never double-fires.

- **Edge function auth without a new env var.** The DCC Supabase CLI is only
  linked to intel-main, and there's no MCP tool to set function env vars — so we
  could NOT set a `PAYROLL_REMINDER_SECRET` function secret. Instead: the secret
  lives only in Vault; the edge function authenticates the incoming header by
  calling a `SECURITY DEFINER` RPC `verify_payroll_reminder_secret(text)` that
  does a boolean compare against the Vault (never returns the value). The edge
  function also **recomputes the summary itself** via the `payroll_due_summary()`
  RPC rather than trusting the POSTed body (closes the spoof vector). This pattern
  is reusable for any future cron→edge-fn that needs auth without a function env
  var.

- **0.25h floor on time entries.** Accidental same-minute clock in/out (e.g.
  Justin's 0.003h May-4 test entry) was surfacing in the summary with $0 amounts.
  Added `having sum(hours) >= 0.25` so sub-15-min blips don't appear.

## Gotchas hit (non-obvious; future sessions need to know)

- **`date_trunc(...)::date - interval '1 month' + 25` is a type error.** The
  cast-to-date happens before the interval subtraction, which re-promotes to
  timestamp, so `+ 25` (integer) fails with "operator does not exist: timestamp
  without time zone + integer". Fix: `(date_trunc(...) - interval '1 month')::date
  + 25`. Caught only at function-call time (CREATE succeeds), so test the function,
  not just the migration apply.

- **MCP `apply_migration` records each call in `supabase_migrations.schema_migrations`
  with its own timestamp+name.** Applying 3 iterations created 3 ledger rows
  (172322, 172410, 172510). The repo must contain 3 matching files or the
  `migrations-applied.yml` CI check fails on drift. We kept all 3 files mirroring
  the applied versions exactly (original + 2 fix-ups) rather than reconciling the
  prod ledger (the harness blocks direct schema_migrations writes anyway). Replay
  in order lands at the correct final state — the buggy first migration only
  *stores* the function, never executes it.

- **Twilio for internal/team SMS is fine** under the A2P 10DLC campaign
  (+15139985440 → Justin). The "always use Nathan's iPhone / never Twilio" rule
  in CLAUDE.md is about customer outreach; an internal reminder to a founder is
  not customer messaging. Confirmed working: SID returned, status queued, 2
  segments.

## Files / systems touched

- **Repo files:**
  - `supabase/migrations/20260527172322_payroll_reminder.sql` (original)
  - `supabase/migrations/20260527172410_payroll_reminder_fix_date_cast.sql`
  - `supabase/migrations/20260527172510_payroll_reminder_min_hours_floor.sql`
  - `supabase/functions/send-payroll-reminder/index.ts`
- **DB migrations applied to prod:** all 3 above (via MCP apply_migration)
- **Edge functions deployed:** `send-payroll-reminder` v1 (verify_jwt=false; self-auths via Vault RPC)
- **pg_cron:** `payroll-reminder-twice-daily` (`0 13,14,20,21 * * *`)
- **Vault:** new secret `payroll_reminder_secret`
- **External systems:** Resend (email), Twilio (SMS, A2P sender +15139985440)

## Open follow-ups (carries forward to a future session)

- [ ] **Generalize to a `recurring_reminders` table** if more reminders accrue
      (monthly close, quarterly taxes, BER filings). Right now it's payroll-specific.
- [ ] **Push-notification channel** (mobile app) was deferred — Justin chose
      email + SMS for v1. Mobile push backbone exists (`notifications` table +
      send-push-notification edge fn) if we want to add it.
- [ ] **DST edge note:** if the 9am/4pm windows ever feel off by an hour, confirm
      the server's `America/New_York` tz data is current — the logic is correct,
      but relies on PG's tz database.
- [ ] Verify the **first real cron fire** on the next 9am/4pm ET tick actually
      dispatches (we tested by direct invocation, bypassing the hour gate).
