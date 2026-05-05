---
# Session 2026-05-05 — Records-request blast: 72 counties, $2.86M verified surplus ingested & triaged

**Owner:** Nathan
**Source JSONL:** <source>
**Status:** DRAFT (auto-generated backfill, needs review)

## What we set out to do
Execute the nationwide Ohio records-request strategy (72 counties emailed asking for surplus lists). Ingest each county's response (xlsx/PDF/docx/.numbers), build verified-surplus JSONs at ≥$5k floor, push to ohio-intel UI, then auto-verify as many as possible via docket scraping to separate still-claimable from already-claimed cases. Goal: identify actionable $$ worth pursuing and skip the ones where competing claims have already been filed.

## Decisions made (durable — these change behavior going forward)
- **Surplus floor is verification-dependent:** Verified surplus (≥$5k floor) vs unverified/source-trusted (≥$20k floor). Verified = clerk records-request response or docket-confirmed via `verify_*_surplus.py`.
- **status taxonomy aligned to Castle:** `still_claimable / already_claimed / unverified` (not `CLEAR / BLOCKED`). NOTICE_OF_APPEARANCE dropped from blocking-signal regex (too noisy — every defense counsel files one). Surplus-specific motions (motion for distribution, motion to intervene, etc.) always block regardless of filing date.
- **Classifier rule:** `blocks present → already_claimed; no blocks AND docket_count>0 → still_claimable; else unverified` (empty dockets from chromedriver crashes no longer mis-classify as still_claimable).
- **DOCKET_DISPATCH extended:** 10 counties now wired (was 4): hamilton, butler, franklin, cuyahoga, **auglaize, hocking, fairfield, hardin, wyandot, seneca**. Each new county becomes auto-verifiable forever after.
- **Henschen platform integrated:** Generic fetcher for ~14 small Ohio counties (Hardin, Wyandot, Seneca, Crawford, Madison when ready). Direct httpx + 2Captcha captcha solver + multi-candidate case-number search (raw alphanumeric → longest numeric run fallback).
- **CourtView 3 search_path kwarg added:** Handles non-standard mount points (Auglaize's `/eservicesCRTV/` vs Butler's `/eservices/`).

## Gotchas hit (non-obvious; future sessions need to know)
- **Gmail tool creates drafts, not sends.** Had to draft all 72 records-request emails (5 initial + 67 state-wide blast) then Nathan sent them manually. 3 bounced (Ashland / Clark / Carroll — OCCA had stale addresses; Ashland & Clark fixed, Carroll needs phone call).
- **Clerk responses vary wildly:** Columbiana sent a clean foreclosure-specific "Open Items" xlsx (1,318 rows / $877k raw). Van Wert sent a general cashbook (every deposit, not surplus-specific — no actionable rows). Madison/Seneca sent scanned PDFs requiring OCR. Auglaize sent Apple Numbers format (needed `numbers_parser`). Fairfield sent 50-page cashbook with 1,268 rows mixed with bonds/transcript deposits/garnishments. Each format needed custom parsing.
- **Henschen captcha gating:** Hardin's Henschen install was captcha-free; Wyandot/Seneca/Crawford/Madison have 2Captcha image gates. The Henschen fetcher now solves captcha automatically but county-specific config (captcha URL, form field names) vary slightly.
- **Henschen case-number search is substring-based:** Wyandot stores `19CV0104` but searching `190104` (concat) returns 0 matches; searching `0104` (longest run) returns 0 matches; searching `19CV0104` (raw alphanumeric) returns matches. The form's "numbers only" hint was misleading. Fixed by trying raw case number first, then longest numeric run, then concatenate.
- **Chromedriver crashes (SIGSEGV) every ~8–10 cases on CV3:** Status code -11. Castle's CLAUDE.md already documented this. Fixed by wrapping each case in a subprocess (pattern from `calibrations/cv3_fleet_sweep.py`). `scripts/verify_surplus_isolated.py` now spawns a fresh Python+chromedriver per case — crashes become retryable failures instead of batch killers.
- **Bright Data Web Unlocker accepts POST via `body` field (not `data`/`payload`/`request_body`).** Found by trial; every other field name returns Joi validation error. Added `body` kwarg to `_fetch_via_unlocker` in `hamilton_courtclerk.py`.
- **Hamilton PDF extraction needs POST + form params:** No anchor tag — image downloads via a 5-input form POST to `image_view_stream.php`. Had to parse `<form>` block + 5 hidden inputs during docket fetch, then POST through Web Unlocker. Bright Data Web Unlocker strips leading `\r\n` from PDF responses (returns valid PDF but with leading junk); fixed by stripping before `%PDF-`.
- **Franklin session-cookie bug:** PDF fetcher didn't share Franklin's disclaimer-acceptance cookie. Fixed by adding `franklin_pdf_fetcher(url) → bytes` (sync, GETs `acceptDisclaimer` once to seed cookie, then GETs the URL; mirrors `FRANKLIN_USE_BRIGHT_PROXY` opt-in).
- **Jeff Kalniz (Nathan's attorney) also represents Get Liduid Funding LLC** (competing surplus locator). Discovered when Auglaize's Cindy Ott case showed 3 Get Liduid intervention motions filed by Kalniz (all denied 06/12/2024 for failure to establish standing; likely to refile). Nathan is aware — no fresh conversation needed per his directive. Memory entry created to avoid flagging this as a new concern in future sessions.
- **Funds-landed detection too strict:** Hocking's Private Selling Officer flow doesn't have an explicit "DEPOSIT OF SURPLUS" docket line — classifier originally punted those to `unverified` even though the records-request response itself proves the funds are at the clerk. Simplified classifier to rely only on blocking signals (if no competing claims detected, classify as still_claimable regardless of deposit phrasing).

## Files / systems touched
- **Repo files:**
  - `utils/henschen.py` — new docket fetcher (Henschen & Associates platform, covers ~14 small Ohio counties)
  - `utils/hamilton_courtclerk.py` — extended `_fetch_via_unlocker` to support POST + `as_bytes`; added `_IMAGE_FORM_RE` / `_HIDDEN_INPUT_RE` to parse image-download forms; added `make_hamilton_pdf_fetcher(post_data, case_number)` closure factory
  - `utils/franklin.py` — added `franklin_pdf_fetcher(url) → bytes` (sync, session-cookie aware)
  - `utils/case_lookup.py::courtview3_fetch_docket` — added `search_path` kwarg for non-Butler CV3 mounts
  - `utils/docket_lookup.py` — added `_courtview3`, `_henschen`, `_auglaize_courtview3`, `_hocking_courtview3`, `_fairfield_courtview3`, `_hardin_henschen`, `_wyandot_henschen`, `_seneca_henschen` to `DOCKET_DISPATCH`; added `pdf_post_data: Optional[dict]` to `UnifiedDocketEntry`
  - `utils/surplus_verify.py` — `_fetcher_for` now takes the full event so it can build per-event Hamilton fetchers from `ev.pdf_post_data`
  - `scripts/verify_surplus_isolated.py` — new subprocess-isolated runner (chromedriver-crash-safe, 2Captcha integrated)
  - `scripts/merge_triage_results.py` — folds verification results into master CSV
  - `docs/PDF_FETCH_TODOS.md` — updated Franklin/Hamilton sections to mark fixed
  - `docs/VERIFIED_SURPLUS_LEG.md` — new architecture doc for ohio-intel hand-off
  - `docs/RECORDS_REQUEST_INGEST_WORKFLOW.md`