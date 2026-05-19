# Director ↔ DCC interface contract

**Last updated:** 2026-05-16 (by Director / intel-main session)
**Living doc.** Either side updates as the contract evolves. Bump the date when you do.

## Domains

| Owns | Director (intel-main) | DCC (Justin) |
|---|---|---|
| Database | `intel-main` Supabase project (`qbdslghonhuvkacqlsbd`) | `DCC` Supabase project (`rcfaashkfpurkvtmsmeb`) |
| Core entity | `intel_case` (cross-state cases: OH/IN/FL) | `deals` (the working lead) |
| Scope | data + scrapers + audit + state coordination + grading + push gate | sales workflow + outreach + UI for Eric/Nam/Nathan/Justin |
| UI | `main-intel.vercel.app` (operator-internal) | `app.refundlocators.com` (team + clients + attorneys) |
| Out of scope | outreach, SMS, comms, deals workflow | scraping, case ingestion, walker pipelines |

## Tables intel-main writes to in DCC

| Table | When | What | Why |
|---|---|---|---|
| `deals` | Operator clicks "Push to DCC" (manual or bulk) | INSERT new row with `type='surplus' status='new-lead'` + full meta + back-ref `meta.intel_case_id` | First push of a lead |
| `deals.meta` | Every 30 min via cron `sync-deal-updates` | UPDATE merging fresh field values when intel_case changes — see managed-keys list below | Keep DCC fresh as cases evolve |
| `activity` | On every push or sync | INSERT audit row like "Imported from intel-main · grade A · bulk push 2026-05-14" or "intel-main sync · updated salePrice, totalDebt" | Audit trail |
| `intel_subscriptions` | Auto via DCC trigger `tg_ensure_intel_subscription` when deals.meta has courtCase+county | DCC's trigger; we don't write directly | Subscribes the case to DCC's intel-sync EF |

### Managed `deals.meta` keys (intel-main writes; DCC must not mutate)

intel-main sets these via initial push + keeps them fresh on the 30-min sync cron. **DCC code/SQL must not mutate them directly** — if a change is needed, do it through intel-main and the next cron reconciles. (DCC operators editing the deal form should not be touching these either; they're populated automatically.)

| key | source in intel-main | example |
|---|---|---|
| `intel_case_id` | `intel_case.id` (back-ref uuid) | `072a4da2-…` |
| `intel_main_url` | derived | `https://main-intel.vercel.app/case/<id>` |
| `county` | `intel_case.county` (title-cased) | `Lake` |
| `courtCase` | `intel_case.case_number` | `25CF001992` |
| `grade` | `intel_case.grade` | `A` |
| `gradeScore` / `grade_score` | `intel_case.grade_score` | `60` |
| `estimatedSurplus` | `surplus_amount_cents / 100` | `283654` |
| `salePrice` | `sale_price_cents / 100` | `670700` |
| `judgmentAmount` | `judgement_amount_cents / 100` (or hamilton_portal fallback) | `346804` |
| `totalDebt` | `enrichment.raw.total_debt_on_deed` | `346804` |
| `courtAppraisalValue` | `enrichment.raw.appraised_value` | `600000` |
| `minimumBidAmount` | `opening_bid_cents / 100` | `400000` |
| `saleDate` | `enrichment.raw.sale_date` / `sale_at` / portal fallback | `2026-05-04` |
| `auctionStatus` | `enrichment.raw.auction_status` (or portal fallback) | `SOLD` / `ACTIVE` / `WITHDRAWN` |
| `auctionUrl` | `enrichment.raw.auction_url` (or hamilton_portal) | `https://lake.sheriffsaleauction.ohio.gov/…` |
| `plaintiffName` | `intel_case.plaintiff_name` | `Th Msr Holdings LLC…` |
| `parcelId` | `intel_case.parcel_id` | `08-A-024-D-00-021-0` |
| `foreclosureType` | `intel_case.case_type` | `verified_surplus` |
| `isPostAuction` | derived (`salePrice > 0` OR `lifecycle_stage IN (sold,confirmed)`) | `true` |
| `surplusClaimStatus` / `surplus_claim_status` | `intel_case.surplus_claim_status` | `still_claimable` |
| `walkerVerified` / `walker_verified` | `intel_case.walker_verified` | `true` |
| `walkerPlatform` / `walker_platform` | `intel_case.walker_platform` | `hamilton_portal` |
| `lifecycleStage` / `lifecycle_stage` | `intel_case.lifecycle_stage` | `surplus_filed` |
| `buyerName` | `enrichment._hamilton_portal.buyer_name` / `_lake_portal.buyer` | (varies) |
| `lastIntelSyncAt` | `now()` at sync time | `2026-05-16T…Z` |
| `sourced_from`, `sourced_at`, `sourced_by` | set once on initial push | `intel-main` / iso ts / operator email |

**Null handling:** intel-main drops null/undefined keys from the patch before merging — it never overwrites an existing DCC value with `null`. So if a value disappears on the intel-main side, the prior DCC value persists until intel-main has a real replacement.

**Naming inconsistency to clean up later:** some keys are camelCase, some are snake_case (e.g. `walkerVerified` AND `walker_verified` both appear in the current cron output for backward compatibility). DCC's deal form reads camelCase; the snake_case ones are vestigial. Don't depend on the snake_case ones — they may go away.

## Tables DCC writes to in intel-main

**Currently: none.** Phase 2B (planned) will add:

| Table | When | What | Why |
|---|---|---|---|
| `intel_event` (or callback to /api/dcc-callback) | When DCC `deals.status` changes to `signed` / `recovered` / `dead` | Send the change back as `dcc_card_won` / `dcc_card_lost` event | Close the conversion-learning loop |

This is **not yet built.** It's tracked in Director's Phase 2B queue. Justin: when ready, expose a webhook endpoint or post directly to intel-main's `intel_event` table via service-role.

## Cron jobs in play

| Cron | Owner | Schedule | What it does |
|---|---|---|---|
| `push-to-dcc` | intel-main (Vercel) | `*/5 * * * *` | Drains `intel_main.dcc_push_intent` queue → INSERTs new `deals` |
| `sync-deal-updates` | intel-main (Vercel) | `*/30 * * * *` | Detects intel_case diffs → PATCHes `deals.meta` |
| `intel-sync-30min` | DCC (pg_cron) | `0,30 * * * *` | Walks `intel_subscriptions` → pulls fresh docket events from ohio-intel into `DCC.docket_events` |
| `morning-sweep-daily` | DCC (pg_cron) | `0 12 * * *` UTC | Daily email digest to Nathan + Justin |

## Edge Functions we depend on each other for

| EF | Project | Owner | Status |
|---|---|---|---|
| `intel-sync` | DCC | Justin | ✅ live as of 2026-05-13 (rotated secret + set `verify_jwt = false`) |
| `ohio-intel-to-deal` | DCC | Justin | ⚠️ has trigger PK race; Director bypasses with direct insert. Either fix `ON CONFLICT (deal_id) DO UPDATE` on the subscriptions insert OR retire EF — Director's push path doesn't need it |
| `lauren-team-respond` | DCC | Justin | n/a to intel-main |

## Coordination protocol

**Daily/normal**: just work in your own domain. The interface above is stable.

**When changing the interface**:
1. Update this file with the change
2. Bump the date at top
3. Drop a message in the team-chat thread (`justin <-> nathan` or via Nathan-to-Director ferry)
4. The other agent updates their side within their next session

**Cross-session messaging**:
- Director → Justin: post to DCC `team_messages` thread `910f6a07` (justin <-> nathan) as Nathan
- Justin → Director: via Nathan, OR drop a file in `~/Documents/Claude/FundLocators-Vault/05-Operations/Director-Queue/` named `dcc-<short-title>.md`
- Both sides: this file (`DIRECTOR_DCC_INTERFACE.md`) is the canonical contract

## Open coordination items

- ⏳ DCC → intel-main feedback loop (won/lost events) — Director Phase 2B
- ⏳ `COVERED_COUNTIES` list in DCC's intel-sync EF needs to sync with ohio-intel's 75-county registry (Justin's task)
- ⏳ Stark County scraper — OH session work (Nathan ferries to OH session)
- ⏳ `ohio-intel-to-deal` EF PK race — Justin to fix OR retire (Director's path doesn't need it)
- ⏳ OH walker batch of 1,274 unwalked still_claimable cases ($21.45M) — OH session in progress (ferry `oh-2026-05-14-1300`). Results will land in `walker_verified` + `surplus_claim_status` via `sync_ohio_full.py` cron. Expect a wave of grade promotions/demotions when each batch lands.
- ⏳ Hamilton walker money-block backfill — 3 cases (sf-er, sf-company, sf-barkley) pushed to DCC 2026-05-14 with surplus + identity only. OH session asked to backfill `appraised_value`, `total_debt_on_deed`, `minimum_bid`, `sale_date`, `judgment_amount` (ferry `oh-2026-05-14-1530`). Will auto-flow into DCC via sync cron when they land.

## Recent (since last bump)

- **2026-05-14**: bulk push #1 — 26 OH Grade-A unpushed leads went into DCC as `status='new-lead'` ($4.19M total). All carry the expanded meta field set documented above.
- **2026-05-14**: grade rules v5 + v6 shipped (migrations 0013, 0014). v5 added shortfall detection + missing-data caps. v6 demotes `auction_status IN (WITHDRAWN, CANCELLED, BANKRUPTCY, STAYED, HELD, POSTPONED)` with no realized sale to C. 8 OH cases auto-demoted in v6 backfill.
- **2026-05-14**: push-to-dcc + sync-deal-updates crons now carry the full `deals.meta` field set — was previously sending only `salePrice`, `estimatedSurplus`, `grade`, etc. New: `totalDebt`, `courtAppraisalValue`, `minimumBidAmount`, `plaintiffName`, `parcelId`, `auctionUrl`, `foreclosureType`. Sale date bug fixed (was mapping to `filed_date`; now reads `enrichment.raw.sale_date`).

## Naming + ID conventions

- Surplus deal IDs in DCC: `sf-<lastname-slug>` (existing convention). Director honors this when pushing.
- Flip deal IDs: `flip-<streetnumber>` (DCC convention).
- `meta.intel_case_id` is always the `intel_case.id` uuid (the back-reference).
- `meta.intel_main_url` is `https://main-intel.vercel.app/case/<intel_case_id>` (clickable from DCC).
