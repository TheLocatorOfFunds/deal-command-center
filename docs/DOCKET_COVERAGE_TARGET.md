# Docket Coverage — Target & Execution Spec

**For:** the Director (intel-main) + OH/IN state sessions
**From:** DCC session, 2026-06-03 (Nathan made docket coverage the main focus)
**Goal:** raise the share of active surplus leads that pull dockets automatically — "set it and forget it."

> All numbers below are from live queries against the DCC DB
> (`rcfaashkfpurkvtmsmeb`) on 2026-06-03. Reproduce with the queries in the
> last section. Treat the operator as source of truth before acting externally.

---

## Where we are today (the honest number)

**72 of 308 active surplus leads (~23%) are pulling live dockets** — $5.06M of
~$19M in surplus. **Not 0%** (the Today strip was rendering a failed data-load
as "0%"; that's fixed separately on the DCC side). Scrapers are healthy —
`docket_events` ingested new rows as recently as today.

| Bucket | Leads | Surplus $ | What unlocks it |
|---|---|---|---|
| ✅ Pulling live | 72 | $5.06M | nothing — already working |
| 🟠 Scraped county, **not matching** (#275) | 110 | $4.89M | **case-number normalization** (no new scrapers) |
| 🔴 No scraper for the county | 126 | $9.11M | new county scrapers / on-demand |

**"100%" is the wrong target.** Literal 100%-set-and-forget would mean a
maintained scraper for ~40 county court systems across OH **and** IN, including
counties with a single lead. The economical target:

1. **Fix #275** → ~59% (the single biggest jump, zero new infrastructure)
2. **Build the top ~3–5 missing OH counties** → ~75–80%
3. **On-demand pull for the singleton tail** → effectively full coverage of cases that matter

---

## Lever 1 — Fix the case-number matching (#275). HIGHEST ROI.

110 leads / **$4.89M** sit in the **five counties we already scrape every day**
(Cuyahoga, Montgomery, Hamilton, Franklin, Butler). The scraper IS pulling the
docket; we just can't *link* the events because the case number stored on the
deal is formatted differently than what the court/scraper uses. Fix the
normalization once → these pull automatically and forever (crons already run).

### The mismatch is county-specific — evidence (pulling vs stuck, same county):

**Cuyahoga** (30 pulling / 34 stuck) — separators vs concatenated:
- ✅ pulling: `CV 23 981252`, `CV 24 101030`, `CV-22-967388`, `CV-25-119683`
- ❌ stuck: `CV23981252`, `CV21949340`, `CV24100971` (no spaces/hyphens)
- **Fix:** normalize by stripping all non-alphanumerics on BOTH sides before
  matching (`CV 23 981252` and `CV23981252` → `CV23981252`). The matcher
  currently tolerates spaces + hyphens but not the concatenated form.

**Hamilton** (19 pulling / 25 stuck) — missing the `A` prefix:
- ✅ pulling: `A 2202665`, `A 2403625`, `A2402440`
- ❌ stuck: `1904541`, `2400522`, `2403702` (no `A` prefix)
- **Fix:** Hamilton OH cases are **always A-prefixed** (known rule). Prepend/normalize
  the `A` before matching. **Caveat:** a few "hamilton" leads are actually
  **Hamilton County, _Indiana_** (`29D01 2410 MF 011332`, `29D02-2508-MF-009277`) —
  a county-name collision. Those belong to the IN pipeline, not the OH Hamilton
  scraper. Route by case-format/state, don't try to match them in OH.

**Montgomery** (4 pulling / 46 stuck) — **worst offender, format looks the same:**
- ✅ pulling: `2025 CV 03418`, `2025-CV-05846` (all 2025)
- ❌ stuck: `2017 CV 00615` … `2024 CV 06310`, plus `2025 CV 042960` (6-digit)
- The stuck ones are mostly the **same `YYYY CV NNNNN` format but older years**,
  which suggests the Montgomery scraper isn't finding older/less-active cases
  (a lookback or query-scope issue) rather than pure formatting — **needs
  Director investigation.** Also normalize the 5-vs-6-digit sequence padding.

### Acceptance criteria for Lever 1
- A canonical case-number normalizer applied **symmetrically** to the deal's
  `meta.courtCase` AND the scraper's emitted case number before the join/match.
- Re-run matching for the 5 covered counties; target: Cuyahoga + Hamilton +
  Butler + Franklin stuck → near-zero. Montgomery investigated separately.
- Verify in DCC: `surplus_docket_pulling_ids()` count climbs from 72 toward ~180.

---

## Lever 2 — Build scrapers for the high-$ missing OH counties

126 leads / $9.11M have no scraper. Concentrated in a few OH counties worth
building (each then runs set-and-forget on the cron):

| County (OH) | Leads | Surplus $ |
|---|---|---|
| **Lorain** | 25 | $1.37M |
| **Fairfield** | 8 | $0.70M |
| **Warren** | 12 | $0.65M |
| Delaware | 4 | $0.43M |
| Muskingum | 2 | $0.27M |
| Lake | 2 | $0.25M |
| Ashtabula | 2 | $0.25M |
| Greene | 2 | $0.24M |

Building just **Lorain + Warren + Fairfield** ≈ **$2.7M / 45 leads**. Each county
clerk site differs, so each is a real build — prioritize by $ as above.

---

## Lever 3 — The singleton tail: on-demand, not permanent scrapers

~30 counties with 1–2 leads each (a long tail). A dedicated maintained scraper
for a one-lead county isn't economical. Two options that are already plumbed:
- **`court_pull_requests`** table = DCC → Castle "scrape this case on demand."
  Fire one when an operator actually works that lead.
- Manual clerk check at work-time.

**Indiana counties go to the IN pipeline, not OH scrapers.** Flagged by IN-style
case numbers (`29D01-2410-MF-…`): Elkhart ($368k/5), St. Joseph ($335k/4),
Vanderburgh ($201k/5), and likely some "Allen"/"Hamilton" leads. These are a
separate effort owned by the Indiana session — don't build OH scrapers for them.

---

## Net effect if executed

| Step | New coverage | Cumulative |
|---|---|---|
| Today | 72 leads (23%) | 23% |
| + Lever 1 (#275 fix, 5 covered counties) | +110 | ~59% |
| + Lever 2 (Lorain/Warren/Fairfield) | +45 | ~75% |
| + top remaining OH counties + IN pipeline | +~30 | ~85% |
| + on-demand for singleton tail | the rest | effective full coverage |

Set-and-forget is *already* how covered+matched leads behave (the 5 crons run
nightly). The work is: fix matching (#275) + extend the cron rotation to the
high-$ counties. Then it runs itself.

---

## Reproduce (run against `rcfaashkfpurkvtmsmeb`)

```sql
-- coverage buckets + $
WITH s AS (
  SELECT id, lower(trim(regexp_replace(coalesce(meta->>'county',''), '\s*county\s*$','','i'))) AS county,
    COALESCE((meta->>'estimatedSurplus')::numeric, surplus_estimate, 0) AS surplus
  FROM deals WHERE type='surplus' AND status NOT IN ('closed','dead','recovered') AND deleted_at IS NULL
), ev AS (SELECT DISTINCT deal_id FROM docket_events)
SELECT CASE
  WHEN id IN (SELECT deal_id FROM ev) THEN '1_pulling'
  WHEN county IN ('franklin','hamilton','cuyahoga','butler','montgomery') THEN '2_stuck_#275'
  ELSE '3_no_scraper' END AS bucket,
  count(*) leads, round(sum(surplus)) total_surplus
FROM s GROUP BY 1 ORDER BY 1;

-- case-format evidence (pulling vs stuck per county)
-- see the DCC session transcript 2026-06-03 for the exact query.
```

**Sources:** live DCC DB queries 2026-06-03 (`deals.meta.county/courtCase`,
`docket_events`, `intel_subscriptions.status`, `surplus_docket_pulling_ids()`).
intel_subscriptions cross-check: `no_match`=208, `county_unbuilt`=93, `matched`=4.
Confirm against intel-main before acting externally.
