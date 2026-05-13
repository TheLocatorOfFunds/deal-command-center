# Handoff from intel-main → DCC · 2026-05-13

**From:** Director / intel-main Claude session
**To:** Justin (DCC owner)
**Re:** Your 3 notes (intel-sync 401 · Stark coverage · sale_price writeback)

## TL;DR

1. **intel-sync 401** — your fix is right; Nathan has the SQL snippet to run (see below)
2. **Stark coverage** — OH session is at 75 LIVE counties now (not 4); your `COVERED_COUNTIES` list in `intel-sync` EF is stale. Suggesting you update it.
3. **sale_price writeback** — **built. Shipping today.** intel-main now pushes UPDATEs to `DCC.deals.meta` whenever an intel_case row changes (sale_price, isPostAuction, surplus, walker, grade, lifecycle, auction_status, buyer_name, etc.). Cron runs every 30 min.

## Detail

### #1 intel-sync 401 fix

Confirmed Nathan has the SQL to paste in DCC's project (`rcfaashkfpurkvtmsmeb`):

```sql
SELECT vault.update_secret(id, '<paste current EF secret value>', 'intel_sync_secret')
FROM vault.secrets WHERE name = 'intel_sync_secret';
```

Once fixed, all the intel_subscriptions rows my push worker has been creating since I shipped (see #3) will start draining — those deals should populate docket events in DCC retroactively.

Note: my push worker creates intel_subscriptions automatically via your `tg_ensure_intel_subscription` trigger when it inserts into `deals` with `meta.courtCase` + `meta.county` set. So all my `sf-*` deals are queued for intel-sync.

### #2 Stark + COVERED_COUNTIES list

I read your `intel-sync` EF — `COVERED_COUNTIES` lists Butler/Cuyahoga/Franklin/Montgomery. But ohio-intel is at **75 counties LIVE** as of 2026-05-13 (per their session activity):

- Castle-walked: Cuyahoga (deep) · Montgomery · CV3 fleet (51 counties — Lorain, Summit, Lake, etc.) · Hamilton · Franklin · Butler
- Henschen platform: Crawford (just shipped) · plus 11 Henschen-tier counties (Adams, Brown, Hardin, Seneca, Wyandot, Clinton, Huron, Fayette, Harrison, Noble, Perry) — most via γ-3 NOD scanner
- Plus several BenchmarkWeb / Lake County stack counties

**Stark is NOT in OH session's LIVE list** but is on their gap roadmap. They have 11 more counties to bring online (~7-9 hr of focused work per their last OUTBOX). I've routed a ferry to bump Stark up the priority list.

You can probably just sync DCC's `COVERED_COUNTIES` to ohio-intel's `_COUNTIES` registry programmatically rather than hand-maintaining. Their registry is at `~/Documents/Claude/ohio-intel/intel/scrapers/county_clerk/_registry.py` or similar.

### #3 sale_price writeback — SHIPPED today

**New endpoint:** `/api/cron/sync-deal-updates` on `https://main-intel.vercel.app`
**Schedule:** every 30 min (`*/30 * * * *`)
**Auth:** Bearer `CRON_SECRET` env var

**What it does:**
- Reads `intel_case` rows where `dcc_card_id IS NOT NULL` AND (`updated_at > last_dcc_sync_at` OR `last_dcc_sync_at IS NULL`)
- For each, fetches the matching `DCC.deals.meta`, computes a diff against current intel_case state, PATCHes only changed keys (merges, doesn't overwrite your meta)
- Writes an activity row in DCC: `intel-main sync · updated salePrice, isPostAuction, ...`
- Stamps `intel_case.last_dcc_sync_at` after success
- Emits `dcc_card_synced` event in intel-main firehose

**Fields propagated to `deals.meta` (camelCase, matching your SurplusOverview reader):**

| Field | Source |
|---|---|
| `salePrice` | intel_case.sale_price_cents / 100 |
| `isPostAuction` | `lifecycle_stage IN (sold, confirmed) OR sale_price > 0` |
| `estimatedSurplus` | intel_case.surplus_amount_cents / 100 |
| `surplusClaimStatus` | intel_case.surplus_claim_status |
| `walkerVerified` | intel_case.walker_verified |
| `walkerPlatform` | intel_case.walker_platform |
| `grade` + `gradeScore` | from intel_case |
| `lifecycleStage` | intel_case.lifecycle_stage |
| `auctionStatus` | enrichment.raw.auction_status |
| `buyerName` | _hamilton_portal.buyer_name / _lake_portal.buyer |
| `judgmentAmount` | intel_case.judgement_amount_cents / 100 |
| `saleDate` | enrichment.raw.sale_at / sale_date / _hamilton_portal.sale_date |
| `lastIntelSyncAt` | `now()` timestamp on each sync |

**Null-safety:** drops null values from the patch so we don't overwrite your meta keys with nulls.

**Idempotency:** only PATCHes keys whose value actually differs from current DCC.deals.meta. If nothing changed, just stamps `last_dcc_sync_at` and moves on.

**What this means for you:**
- Your `meta.salePrice` + `meta.isPostAuction` fields now auto-update without you building anything
- intel-sync EF stays scoped to docket events (its original purpose); my writeback handles case-level fields
- Works for **all 3 states** (OH/IN/FL), not just OH counties
- No DCC code changes needed

If you want the audit trail, activity rows show up on each deal: `intel-main sync · updated salePrice, isPostAuction`.

## Anything else I should know?

I'm coordinating via this file. If you want a different protocol (Slack-style or pushing to your `WORKING_ON.md`), let me know via OUTBOX in `~/Documents/Claude/FundLocators-Vault/05-Operations/Director-Queue/` or just edit this file with a reply.

— Director (intel-main session)
