---
# Session 2026-04-27 — Detail-page enrichment pipeline shipped (86 rows decorated)

**Owner:** Nathan
**Source JSONL:** `/Users/alexanderthegreat/.claude/projects/-Users-alexanderthegreat-Documents-Claude/b9076c14-8e60-4f17-858f-b71727f1b267.jsonl`
**Status:** DRAFT (auto-generated backfill, needs review)

## What we set out to do
Execute the 8-step prequal pipeline (NEXT_PROMPT.md 2026-04-27) to enrich the 566 baseline `intel.cases` rows with detail-page fields (parcel_id, appraised_value, foreclosure_type, opening_bid, defendant_primary, case_status) required for A/B/C lead grading. Scope limited to probe verification + targeted 5-county sweep (Option C) this session; full 88-county detail fetch deferred to Step 2 in next session per Nathan's preference.

## Decisions made (durable — these change behavior going forward)
- **Realauction detail-page DOM selectors locked**: `<th class="bLab">LABEL:</th><td class="bDat">VALUE</td>` universal across all 88 OH counties (probed cuyahoga ×6, hamilton, butler, summit, 10 pages total). Parcel XPath `//th[contains(normalize-space(),'Parcel ID')]/following-sibling::td[1]` handles label variance ("Parcel ID:" vs "Parcel ID & Property Details:"). `bypassPage=1` query param skips disclaimer popups.
- **Party-name normalization rule**: slash-separated names (`LAST/FIRST/`) → "First Last". Comma-separated (`Last, First`) → "First Last". Org names title-cased with acronym preservation (LLC, INC, LLP, USA, EPA → keep caps; "OHIO" / "DEPARTMENT OF" → Title Case). Implemented in `scripts/probe_88_counties.py:normalize_party_name`.
- **`defendant_primary` is the first non-org defendant**: Multi-defendant cases (e.g. Citifinancial + Smith/John) store Smith/John as defendant_primary, full list in `case_party`. Homeowner identification rule is "first defendant matching person-name pattern" (not "first row in party table").
- **Migration 0007 schema**: 14 new columns on `ohio_case`: `foreclosure_type`, `sale_type`, `case_status`, `special_note`, `appraised_value`, `opening_bid`, `minimum_bid`, `auction_url`, `defendant_primary`, `total_debt_on_deed`, `surplus_estimate`, `grade` (text + CHECK A/B/C), `graded_at`, `grader_version`. Idempotent. 3 partial indexes on grade/foreclosure_type/case_status. Applied to `wjdmdggircdengdingtn` 2026-04-27 PM.
- **Detail-page fetch cost**: Single-county detail-fetch adds ~3s per item. Full 88-county sweep with detail-page: 566 items ×3s ≈ +28 min → 90 min → **120-135 min total** (NOT the 7-8 hr feared in NEXT_PROMPT.md — that assumed login re-paid per item, which doesn't happen).
- **Tax sales have appraised_value=$0 by design**: `DELINQUENT TAX SALE` foreclosure_type → appraised_value $0.00 is expected (sold for back taxes, not market value). Store `foreclosure_type` as a discriminator so the grader can filter tax sales or treat them differently.
- **88-county refresh is a one-time snapshot until Step 7**: The 566 rows don't auto-refresh yet. Legacy Castle timers (5 counties) still running per AGENTS.md §1 pivot. 88 realsheriff systemd timers NOT deployed; that's Step 7, gated by stagger-schedule approval.

## Gotchas hit (non-obvious; future sessions need to know)
- **55 of 73 probe "no-match" rows were post-auction items**: The probe script walked "first foreclosure day" without checking if the date was past. It captured items with status="Sold"/"Pending Post" (auctions concluded that morning). The original 88-county sweep correctly skipped those via `_is_sold_status`. Not a bug; just probe-vs-sweep scoping difference.
- **Some counties have non-standard party-table DOM** (fairfield, franklin, licking, knox returned empty parties). The probe's `//tr[td[div[text()='DEFENDANT']]]/td[2]/div` XPath works on 73/88 counties; Step 2 needs a fallback parser for the ~15 variants.
- **Summit merges parcel + address in one cell** ("Parcel ID & Property Details:"). Store as-is; BatchData will normalize. Affects ~67 Summit rows (real volume).
- **DB password in VPS `INTEL_DATABASE_URL` is stale** (open blocker STATUS.md:74). Migration 0007 required manual paste into Supabase Studio SQL editor. psycopg v3 connection will fail from VPS until password reset.
- **Duplicate case_numbers across rescheduled pluries sales**: The C-sweep counted 172 "updates" but only 86 distinct rows decorated — rescheduled sales (e.g. SECOND PLURIES, THIRD PLURIES) share the same case_number. Not a dupe-write error; DB correctly de-dupes on (`county`, `case_number`).

## Files / systems touched
- **Repo files:**
  - `db/migrations/0007_lead_grading.sql` — 14 new ohio_case columns + 3 indexes + 1 CHECK constraint
  - `web/lib/types.ts` — added 14 fields to OhioCase type
  - `web/lib/cases.ts` — extended CASE_LIST_SELECT with new columns
  - `web/app/cases/CasesClient.tsx` — added Type/Appraised/Opening/Sale/Grade list columns
  - `web/app/cases/CaseDrawer.tsx` — added 9 detail fields + Realauction link
  - `web/app/cases/helpers.ts` — added foreclosureTypeVariant, gradeVariant, caseDefendantPrimary
  - `scripts/probe_88_counties.py` — 88-county detail probe + party-name normalizer
  - `scripts/replay_probe_to_db.py` — JSONL → DB replayer with homeowner-picker
  - `scripts/sweep_topvol_counties.py` — Option C 5-county targeted sweep
  - `STATUS.md` — updated counts, queued Step 2
  - `DECISIONS_LOG.md` — appended 6 locked decisions
  - `NEXT_PROMPT.md` — drafted Step 2 contract (preview.py refactor)
- **DB migrations:** 0007_lead_grading.sql applied to `wjdmdggircdengdingtn`
- **Edge functions deployed:** none
- **External systems:**
  - VPS `deploy@5.161.200.249` — ran 3 probe scripts + 1 sweep script (no systemd changes)
  - Vercel production — deployed web/ → https://ohio-intel.vercel.app/cases (live)

## Open follow-ups
- [ ] Step 2 — refactor preview.py to fetch detail-page fields inline on every calendar item (ETA next session, ~4-5 hr)
- [ ] Step 3 — enrichment_brightdata.py for total_debt_on_deed (blocked on `BRIGHT_BROWSER_PASS`)
- [ ] Step 4 — enrichment_county.py for judgment_amount (5 counties only, port from castle-v2)
- [ ] Step 6 — grader re-pass on all rows with judgment_amount + opening_bid
- [ ] Step 7 — deploy 88 realsheriff systemd timers (gated by stagger-schedule approval)
- [ ] Step 8 — decommission 5 castle-*.service units (explicit greenlight required)
- [ ] Fix party-table parser for the ~15 counties returning empty parties (fairfield, franklin, licking, knox, etc.)
- [ ] Reset VPS DB password in Supabase Studio so `INTEL_DATABASE_URL` works from VPS psycopg connections
---