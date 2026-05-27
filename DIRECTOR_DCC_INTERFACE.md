# Director ↔ DCC interface contract

**Last updated:** 2026-05-27 (by Director / intel-main session — added confidenceTier/confidenceLabel meta keys for the walker-verified vs complaint-inferred tier differentiation)
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
| `confidenceTier` | derived — `walker_verified` (a walker confirmed real + still-claimable surplus, non-tax) vs `complaint_inferred` (confirmed by inference; **all tax foreclosures land here** — walker confirms claimability, not absence of a senior mortgage). **Set on confirmed leads only**; non-confirmed/legacy deals stay unset. | `walker_verified` / `complaint_inferred` |
| `confidenceLabel` | human label for the tier (badge text) | `Walker-verified` / `Complaint-inferred · verify lien` |
| `buyerName` | `enrichment._hamilton_portal.buyer_name` / `_lake_portal.buyer` | (varies) |
| `lastIntelSyncAt` | `now()` at sync time | `2026-05-16T…Z` |
| `sourced_from`, `sourced_at`, `sourced_by` | set once on initial push | `intel-main` / iso ts / operator email |

**Null handling:** intel-main drops null/undefined keys from the patch before merging — it never overwrites an existing DCC value with `null`. So if a value disappears on the intel-main side, the prior DCC value persists until intel-main has a real replacement.

**Naming inconsistency to clean up later:** some keys are camelCase, some are snake_case (e.g. `walkerVerified` AND `walker_verified` both appear in the current cron output for backward compatibility). DCC's deal form reads camelCase; the snake_case ones are vestigial. Don't depend on the snake_case ones — they may go away.

## DCC → intel-main feedback (the lead-outcome loop)

DCC doesn't write to intel-main tables directly. Instead, **DCC records the
outcome on its own `deals.meta`, and intel-main reads it back** via cron
`sync-lead-outcomes`. This is the reverse of the managed-keys flow above.

### DCC-owned `meta` keys (DCC writes; intel-main only READS)

Set when a **surplus** deal is marked `status='dead'`. Build spec:
`deal-command-center/docs/LEAD_OUTCOME_FEEDBACK_BUILD.md`.

| key | value | written by |
|---|---|---|
| `dispositionReason` | one code from the vocabulary below | DCC "mark dead" UI |
| `dispositionAt` | ISO timestamp | DCC |
| `dispositionBy` | profile id / name (optional) | DCC |

**Reason vocabulary** (code → category; category is derived by intel-main, DCC just stores the code):

| code | category | meaning |
|---|---|---|
| `already_claimed` | bad_lead | surplus already claimed / disbursed |
| `no_surplus` | bad_lead | no real surplus after debts/liens |
| `bad_data` | bad_lead | wrong case / duplicate / bad data |
| `unworkable_estate` | bad_lead | deceased, no heir/claimant findable |
| `no_response` | no_deal | couldn't reach the homeowner |
| `declined` | no_deal | homeowner declined |
| `hired_competitor` | no_deal | signed with a competitor |
| `other` | no_deal | anything else (neutral default) |

`bad_lead` = qualification miss (gates auto-push). `no_deal` = real lead that
didn't convert. intel-main lands these on `intel_case.outcome_reason` /
`outcome_category` and computes `v_qualification_scoreboard` (bad-lead rate by
grade + the walker+lien+claimable "safe slice"). That rate is the gate for
turning on automatic lead flow (the auto-push path, Step 1).

**DCC must not** write `outcome_*` anywhere — those are intel-main columns.
DCC only owns the three `disposition*` meta keys. Resurrecting a dead lead
(status off `dead`) needs no cleanup on DCC's side — intel-main clears its own
outcome record when it sees the deal is no longer dead.

## Cron jobs in play

| Cron | Owner | Schedule | What it does |
|---|---|---|---|
| `push-to-dcc` | intel-main (Vercel) | `*/5 * * * *` | Drains `intel_main.dcc_push_intent` queue → INSERTs new `deals` |
| `sync-deal-updates` | intel-main (Vercel) | `*/30 * * * *` | Detects intel_case diffs → PATCHes `deals.meta` |
| `sync-lead-outcomes` | intel-main (Vercel) | `15,45 * * * *` | Reads `deals.meta.dispositionReason` on dead leads → writes `intel_case.outcome_*` (the feedback loop) |
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

- 🚨 **ACTION FOR DCC (2026-05-20): clear 90 stale IN surplus leads from Eric's active queue.**
  Eric worked 20 of the 119 IN surplus leads pushed 5/19 → **100% kill rate**. Director
  re-walked all 260 IN `still_claimable` cases live through mycase with an evidence-based
  classifier (escheat-age, distribution, dismissal, appeal, satisfaction, sale-confirmation).
  Result: only 55 of 260 survive as `still_claimable`. **90 of the 119 already-pushed leads
  are not workable.** intel-main has already corrected `surplus_claim_status` on all of them
  (committed 2026-05-20), so `sync-deal-updates` will push the corrected
  `meta.surplusClaimStatus` to these DCC cards within 30 min. **What's left is the DCC-side
  workflow move** (deals.status — your domain; intel-main can't and won't write it):
  - **ARCHIVE — 49 confirmed dead** (already_claimed / escheated >5yr / dismissed / on-appeal):
    `sf-a sf-al sf-allen sf-anna sf-barbara sf-c-2 sf-cecil sf-dalayna sf-dec sf-dec-2 sf-eugene-2 sf-f sf-gregory sf-group sf-heather sf-jacqueline sf-jeffrey sf-jennifer sf-kathy sf-kevin sf-l-3 sf-l-6 sf-lanham sf-law sf-linda sf-m-2 sf-m-3 sf-marcia sf-marie sf-may sf-mica sf-michael sf-oldfield sf-patricia sf-randall sf-robert-2 sf-russell sf-service sf-shanda sf-shane sf-spv sf-sue sf-terry sf-todd sf-usda sf-v sf-vaune sf-wanda sf-william-2`
  - **PARK — 41 unverified, revivable; do NOT hard-delete** (stale 2-5yr, need a fresh clerk
    records-request before they can be trusted either way):
    `sf-a-2 sf-a-5 sf-aaron sf-ann sf-arthur sf-association sf-authority sf-c sf-christopher sf-corey sf-d sf-deceased-2 sf-deceased-4 sf-diane sf-e-2 sf-ethel sf-fuller sf-i sf-j-4 sf-janice sf-kasey sf-l sf-l-4 sf-l-5 sf-lee sf-lynesha sf-martha sf-mindy sf-mitchell sf-na sf-r sf-roberto sf-ryan-2 sf-sharon sf-t-2 sf-terrance sf-terry-2 sf-tonya sf-w sf-willie sf-wmc1`
  - Per-card detail (case#, county, $, exact disqualifier, age) in the CSV at
    `~/Documents/Claude/indiana-pipeline/metadata/_rewalk/DCC_kill_list.csv` (disposition column).
  - The 27 surviving pushed leads keep `surplusClaimStatus=still_claimable` — leave them in queue.
  - Root-cause fix in progress on Director side: the day-1 IN walker defaulted "no blocking
    pattern" → `still_claimable` (innocent-until-proven) and never gated on case age, so years-old
    already-disbursed cases shipped as live. New classifier flips that default. Will re-run on the
    full IN verified set, not just the 260.
- ⏳ DCC → intel-main feedback loop (won/lost events) — Director Phase 2B
- ⏳ `COVERED_COUNTIES` list in DCC's intel-sync EF needs to sync with ohio-intel's 75-county registry (Justin's task)
- ⏳ Stark County scraper — OH session work (Nathan ferries to OH session)
- ⏳ `ohio-intel-to-deal` EF PK race — Justin to fix OR retire (Director's path doesn't need it)
- ⏳ OH walker batch of 1,274 unwalked still_claimable cases ($21.45M) — OH session in progress (ferry `oh-2026-05-14-1300`). Results will land in `walker_verified` + `surplus_claim_status` via `sync_ohio_full.py` cron. Expect a wave of grade promotions/demotions when each batch lands.
- ⏳ Hamilton walker money-block backfill — 3 cases (sf-er, sf-company, sf-barkley) pushed to DCC 2026-05-14 with surplus + identity only. OH session asked to backfill `appraised_value`, `total_debt_on_deed`, `minimum_bid`, `sale_date`, `judgment_amount` (ferry `oh-2026-05-14-1530`). Will auto-flow into DCC via sync cron when they land.

## Recent (since last bump)

- **2026-05-20**: IN verified-surplus re-walk + reclassification. All 260 IN `still_claimable`
  cases re-walked live via mycase. `surplus_claim_status` corrected in `intel_case`:
  55 still_claimable / 95 unverified / 109 already_claimed / 7 claim_in_progress; 116 archived.
  90 of the 119 leads pushed 5/19 are now flagged for queue removal (see Open coordination items).
  Corrected statuses flow to DCC via the normal `sync-deal-updates` cron — no manual DCC meta edit.
- **2026-05-14**: bulk push #1 — 26 OH Grade-A unpushed leads went into DCC as `status='new-lead'` ($4.19M total). All carry the expanded meta field set documented above.
- **2026-05-14**: grade rules v5 + v6 shipped (migrations 0013, 0014). v5 added shortfall detection + missing-data caps. v6 demotes `auction_status IN (WITHDRAWN, CANCELLED, BANKRUPTCY, STAYED, HELD, POSTPONED)` with no realized sale to C. 8 OH cases auto-demoted in v6 backfill.
- **2026-05-14**: push-to-dcc + sync-deal-updates crons now carry the full `deals.meta` field set — was previously sending only `salePrice`, `estimatedSurplus`, `grade`, etc. New: `totalDebt`, `courtAppraisalValue`, `minimumBidAmount`, `plaintiffName`, `parcelId`, `auctionUrl`, `foreclosureType`. Sale date bug fixed (was mapping to `filed_date`; now reads `enrichment.raw.sale_date`).

## Naming + ID conventions

- Surplus deal IDs in DCC: `sf-<lastname-slug>` (existing convention). Director honors this when pushing.
- Flip deal IDs: `flip-<streetnumber>` (DCC convention).
- `meta.intel_case_id` is always the `intel_case.id` uuid (the back-reference).
- `meta.intel_main_url` is `https://main-intel.vercel.app/case/<intel_case_id>` (clickable from DCC).
