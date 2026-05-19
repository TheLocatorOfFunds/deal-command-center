---
# Session 2026-04-27 — Native realsheriff scraper + 88-county deploy

**Owner:** Nathan
**Source JSONL:** `/Users/alexanderthegreat/.claude/projects/-Users-alexanderthegreat-Documents-Claude/2fc263e4-9689-4499-913c-971479ca510c.jsonl`
**Status:** DRAFT (auto-generated backfill, needs review)

## What we set out to do
Complete Mac→VPS cutover (Step 2+3 from 2026-04-26 PM session). Mid-session architectural pivot: Nathan directed full rebuild of Castle's Realauction scraper as native ohio-intel code (`intel.scrapers.realsheriff`), ingesting all 88 OH counties' scheduled foreclosure auctions into `intel.cases`.

## Decisions made (durable — these change behavior going forward)
- **Architectural pivot locked**: Castle stops being a vendored dependency; ohio-intel becomes the native scraper home (replaces "Pattern B fanout" hard boundary in AGENTS.md §1, §6)
- **A/B/C lead grading rule locked**: A=surplus≥$100k + owner alive, B=surplus≥$100k + deceased, C=$10k-$99k (ported from `castle-v2/utils/lead_score.py`; 21 executable test specs in `intel/scrapers/realsheriff/tests/test_grader.py`)
- **Realsheriff persists all scheduled items**: no grade-gate during scrape; enrichment + grading happens post-ingest (separates calendar collection from downstream prequal logic)
- **Prequal pipeline 4-hop spec**: (1) Realauction calendar → parcel_id, case_number, opening_bid, appraised_value; (2) BrightData → total_debt_on_deed; (3) County clerk → judgment_amount; (4) Math → surplus=opening_bid−max(judgment,debt)−fees → A/B/C grade
- **CALW selector fix critical**: must match ALL week-row classes (`CALW1..CALW6`) not just `CALW5` — live DOM confirmed Realauction uses 6-row calendar grid; `CALW5`-only captured 1/6 of foreclosure days; Hocking's missing May 1 sale (6 items) tipped us off

## Gotchas hit (non-obvious; future sessions need to know)
- **Realauction month-advance race**: clicking next-month link updates `#CALDATE` label instantly but `#CALDAYBOX` rebuilds asynchronously; must wait 1.5s post-click or you scrape stale month data (observed: months 2-3 reading 0-cell state)
- **Next-month link selector**: link text is `"May> >"` (with space) not `">>"` (without) — text-match fails; use `aria-label="Next Month <name>"` instead (stable)
- **Realauction login bounce**: direct nav to `{slug}.sheriffsaleauction.ohio.gov/Auction/GetAuctions` after login lands you back on homepage; must click the "Calendar" nav link explicitly (same as `castle-v2/utils/auction.py::navigate_to_calendar()` pattern)
- **Web UI deployment surface**: Vercel requires BOTH `INTEL_SUPABASE_*` (for cases/properties) AND `DCC_SUPABASE_*` (for scrape_runs activity widget); different Supabase projects; `web/lib/supabase.ts` exports both clients
- **Run 1 under-counted by 5-6×**: CALW5-only selector caught ~37 items in 37 counties before we killed it; run 2 (all-week-rows) caught 576 items in same wall time

## Files / systems touched
- **Repo files:**
  - `intel/scrapers/realsheriff/` (new package — 8 modules: `__init__.py`, `__main__.py`, `browser.py`, `counties.py`, `grader.py`, `preview.py`, `types.py`, `writer.py`)
  - `intel/scrapers/realsheriff/tests/test_grader.py` (21 grading rule specs)
  - `intel/scrapers/__init__.py` (new)
  - `web/lib/dashboard.ts` (90-day window, scrape activity widget)
  - `web/lib/supabase.ts` (added `dccClient()`)
  - `web/app/page.tsx` (new "Scrape activity · last 24h" section)
  - `AGENTS.md` §1 + §6 (relaxed Castle hard boundaries)
  - `STATUS.md`, `DECISIONS_LOG.md`, `NEXT_PROMPT.md` (3 rewrites)
- **DB migrations:** None (intel.cases schema already had necessary columns; enrichment migration queued for next session)
- **Edge functions deployed:** None
- **External systems:**
  - VPS (5.161.200.249): ran 2 full 88-county sweeps (run 1 killed mid-flight after Hocking bug catch, run 2 completed)
  - Vercel: 2 prod deploys (`ohio-intel-cqeop3co2`, `ohio-intel-jttkjof7e` → `ohio-intel.vercel.app`)
  - Supabase intel DB: **566 unique rows** inserted into `ohio_case` (source_county_system='realsheriff', stage='sale-scheduled')

## Open follow-ups
- [ ] Judgment enrichment hop (county clerk sites; Castle has partial coverage) — step 4 in NEXT_PROMPT
- [ ] BrightData debt lookup integration (needs `BRIGHT_BROWSER_PASS` env var) — step 3
- [ ] Per-listing detail-page fetch for parcel_id + appraised_value (DOM probe + parser extension) — steps 1-2
- [ ] Schema migration `0007_lead_grading.sql` (add grade, surplus_estimate, enrichment timestamps) — step 5
- [ ] Re-grade pass over 566 existing rows once enrichment sources are wired — step 6
- [ ] Deploy 88 systemd timers on VPS (one firing every ~16 min for 24h rolling refresh) — step 7
- [ ] Decommission 5 legacy `castle-*.service` units (butler, court_pull, cuyahoga, montgomery, main) after native equivalents verified — step 8
- [ ] Investigate Trumbull (200k pop, 0 items returned — likely Realauction doesn't host or DOM differs)

---