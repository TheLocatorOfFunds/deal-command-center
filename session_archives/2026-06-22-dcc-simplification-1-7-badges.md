# Session 2026-06-22 — DCC simplification (1–7) + badge-mismatch sweep

**Owner:** Nathan
**Branch(es):** main (all pushed)
**Related PRs:** —

## What we set out to do
Nathan: "make the DCC simpler and easier to use and more intelligent." Laid out a 7-item plan and executed it top to bottom, then fixed a string of nav-badge mismatches Nathan surfaced along the way.

## Decisions made (durable — these change behavior going forward)
- **Nav collapsed to one Outreach hub.** `OutreachHub` folds the old Automations + Comms + (hidden) Comms-Analytics nav items into one "Outreach" button with 3 tabs (Automations / Messages / Comms Analytics). `forecast` moved Automations→Insights. New 🩺 Health admin view. All old hash routes still resolve via `groupIds`. (`969db76`)
- **Relay: PAUSED but KEPT (NOT decommissioned).** Initially slated for removal (data showed it drained — 0 enrollments/touches, crons off), but Nathan reviewed the live Automations screen and wants the manual Review Mode + Ready-to-Approve/Enrolled + Scan Now flow. So the UI, `relay_*` tables, and EFs all stay. Only removed: 2 already-disabled auto crons (`relay-auto-enroll-every-15min`, `relay-dispatcher-every-15min`). Recreate SQL + full record in local `~/Documents/Claude/DCC_RELAY_DECOMMISSION_2026-06-22.md`.
- **meta→column migration is COMPLETE, not half-done.** Verified `tg_sync_deals_meta_from_columns` mirrors all 33 mapped columns; **0 drift across 417 deals**. The two prior bugs (DECEASED toggle, field-disappear) were the only divergent edit controls. Locked the invariant in a code comment at `META_TO_COLUMN`; no code churn. (`50c3d44`)
- **Dead/deleted deals auto-clean their tasks + docket** — new trigger `tg_cleanup_on_deal_dead` (see Gotchas). (`5079b0f`)
- **Backend prune deferred by design.** `pg_class.reltuples` is -1/unknown for 44 tables — can't ID dead tables without per-table last-write analysis; not safe to bulk-drop, especially given the Relay-keep reversal. The new Health page covers the monitoring that made pruning feel urgent.
- **Review Queue `verify_maybe_gone` flag tightened.** Was matching the normal creditor waterfall ("distributed to [bank]", "funds were disbursed" to pay the judgment) and flagging LIVE surplus as gone (Kingery $46k, Kasper $19k). Now requires surplus-specific gone-language or a hard death signal. 18→7 flags, 12 false positives removed. (`20260622120200`)

## Gotchas hit (non-obvious; future sessions need to know)
- **Nav badge counts must match their tab body's filter.** Three badges drifted: Review badge loaded once at mount and never refreshed (stale-high, showed 56 vs body 30); Follow-ups badge counted raw `tasks` including ones on deleted/dead deals the body hides (showed 1 on deleted deal sf-daggs vs body 0). Fixed: Review badge refreshes on `deals` realtime (debounced); Follow-ups badge → `get_followup_due_count()`. Audited offers/walkthroughs/docket too — clean (docket badge already matches its modal). Logged to CLAUDE.md Gotchas.
- **"Relay" is overloaded.** `RelayView` is the LIVE Automations UI (reads `outreach_queue`), NOT just the dead relay engine. Deleting it on the "Relay is dead" premise would break the live Automations screen.
- **`v_lead_review_queue` returns the SAME count to all team roles.** `is_admin()` = role IN ('user','admin'), so contacts (and the phone/heir flags) are visible to the whole team; the queue doesn't vary by who's looking. (Ruled out a security_invoker/RLS theory for the "shows everything" report — the real cause was the stale badge.)
- **A git conflict marker shipped to prod** earlier in the day (`index.html`, from a #326 rebase) because `build.js` only regex-stamps the version line and never parses the HTML. Added a build guard that fails the build on `<<<<<<<`/`>>>>>>>` markers. (`b03950c`)

## Files / systems touched
- **Repo files:** `src/app.jsx` (OutreachHub, HealthView, DailyWorklist, Review badge realtime refresh, follow-up count via RPC, meta-invariant comment), `build.js` (conflict-marker guard), `CLAUDE.md` (view list + Gotchas refresh).
- **DB migrations (applied via MCP, committed):** `20260622120000_operator_health_fn`, `_120100_daily_worklist_fn`, `_120200_review_queue_tighten_verify_maybe_gone`, `_120300_followup_due_count_fn`, `_120400_cleanup_tasks_docket_on_deal_dead`. Plus dropped 2 disabled relay crons.
- **Edge functions deployed:** none — IP-allowlist gated this session; all work was front-end + `apply_migration` + SQL.
- **Backfill:** closed 120 stale tasks + acked 436 dead-deal docket events (docket unacked 1792→1356).

## Open follow-ups (carries forward to a future session)
- [ ] Relay auto-pipeline is OFF (manual only). Restore SQL in the local decommission doc if unattended cadence is ever wanted.
- [ ] Broad backend table/EF prune still deferred — needs a deliberate per-table last-write analysis pass, not a bulk drop.
- [ ] EF deploys remain IP-allowlist gated from this session — Health/Worklist/etc. needed none, but any future EF change must deploy from a whitelisted machine.
- [ ] ~1,356 unacked docket events remain on LIVE deals (real backlog, not orphans).
