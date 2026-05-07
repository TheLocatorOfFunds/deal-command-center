# Pending review — migrations parked, not active

This subfolder is invisible to the migration drift CI check
(`.github/scripts/check-migrations-applied.mjs`) because the script
only reads files matching `^\d{14}_*.sql$` at the top level of
`supabase/migrations/`. Files moved here are intentionally NOT shipping
to prod yet.

Use this folder when a migration is committed-but-not-ready — typically
because it triggers customer-facing behavior (auto-emails, auto-SMS,
status broadcasts) and the team hasn't yet built the approval gate or
agreed on the rollout plan.

## How to "ship" a parked migration

1. Read it carefully — it may be stale relative to current schema
2. Build any required approval/queue UI first
3. `git mv` it back to `supabase/migrations/` (top level)
4. Apply via Supabase SQL Editor or `apply_migration` MCP
5. Push — CI check should go green

## Currently parked

### `20260505100000_client_status_change_notify.sql`
- **Author:** Nathan, 2026-05-05
- **Effect if applied:** Postgres trigger on `deals.status` UPDATE that
  emails every enabled `client_access` recipient via Resend when status
  hits `signed` / `filed` / `probate` / `hearing-set` /
  `awaiting-distribution` / `recovered`.
- **Why parked:** No human-in-the-loop approval. Per Justin 2026-05-07:
  "We don't need to be sending out emails without someone approving
  them." Need a "pending notifications" queue + approval UI before
  re-shipping.
- **State in prod:** Function `notify_client_status_change()` is INSTALLED
  (we applied it once, then dropped the trigger). Function body remains
  for reuse when the approval flow lands.

### `20260505110000_client_docket_event_notify.sql`
- **Author:** Nathan, 2026-05-05
- **Effect if applied:** Postgres trigger on `docket_events` INSERT that
  emails clients via Resend when a non-backfill event of type
  `hearing_scheduled` / `hearing_continued` / `judgment_entered` /
  `disbursement_ordered` / `disbursement_paid` lands.
- **Why parked:** Same as above — no approval gate.
- **State in prod:** Function `notify_client_docket_event()` is INSTALLED
  (we applied it once, then dropped the trigger). Function body remains.

## Re-attaching the triggers (if/when ready)

The functions are already in the database. To re-enable, just run:

```sql
-- Status-change emails
create trigger tg_notify_client_status_change
  after update of status on public.deals
  for each row
  execute function public.notify_client_status_change();

-- Docket-event emails
create trigger tg_notify_client_docket_event
  after insert on public.docket_events
  for each row
  execute function public.notify_client_docket_event();
```

…but don't do that without an approval flow in front. That's the whole
reason these are parked.
