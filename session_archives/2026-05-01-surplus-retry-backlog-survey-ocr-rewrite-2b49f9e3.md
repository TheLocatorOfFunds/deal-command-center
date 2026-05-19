---

# Session 2026-05-01 — Surplus: retry backlog + survey + OCR rewrite

**Owner:** Nathan
**Source JSONL:** <source>
**Status:** DRAFT (auto-generated backfill, needs review)

## What we set out to do
Resume handoff to clear Cuyahoga's 83-case network-fail backlog, then continue expanding coverage. Mid-session pivot: full 88-county Ohio survey, then PDF storage architecture investigation + OCR pipeline rebuild from Claude Vision to Castle's existing Tesseract + OpenAI stack.

## Decisions made (durable — these change behavior going forward)
- **OCR provider for surplus PDFs: Castle's existing Tesseract + OpenAI GPT-4o** (NOT Claude Vision). Cost ~$0.01/PDF vs ~$0.05-0.20. Nathan explicitly preferred no Anthropic charges. Memory + HANDOFF updated with this choice.
- **PDF storage: reuses DCC's `surplus-pdfs` bucket + `surplus_docket_events` table**. Castle uploads; ohio-intel reads signed URLs. Schema confirmed via service-role probe (2026-05-02).
- **$20k floor is absolute** — Nathan wants no mention of sub-$20k surplus ever (even counts). Feedback memory written.
- **Auditor-fallback methodology documented** ([AUDITOR_FALLBACK_METHODOLOGY.md](metadata/auction/AUDITOR_FALLBACK_METHODOLOGY.md)) — for counties without clerk-published lists, scrape auditor HTML unclaimed-funds tables, filter ≥$20k, cross-reference personal names against sheriff sale records. Proven on Geauga ($132k lead).

## Gotchas hit (non-obvious; future sessions need to know)
- **Cuyahoga CV94277287** got stuck in retry loop because source-trusted evidence said "network timeout" but actual root cause was "case not found" on clerk site. Fixed by marking with non-network evidence so retry script skips it.
- **Franklin's PDF URLs return disclaimer page** — the `pdf_url` lands at `imageLinkProcessor.pdf?coords=...` but generic httpx fetch doesn't share Franklin's session cookie (acceptDisclaimer), so PDF is gated. Fix scoped to 30 min — make Franklin adapter pre-fetch PDFs inside its existing session. Detailed in [PDF_FETCH_TODOS.md](docs/PDF_FETCH_TODOS.md).
- **Many small-county "unclaimed funds" PDFs are the WRONG category** — Ashland/Coshocton/Knox/Huron clerk lists are check-warrant ledgers (vendor refunds, garnishments), NOT sheriff-sale surplus. Surplus exists but isn't published; records-request path is correct.
- **`external_id` in Franklin adapter was positional row index** (e.g. "0001"), not stable. Multiple cases would collide. Fixed by SHA-1-hashing `(case || date || description)` when source `image_id` looks positional (<5 chars numeric).
- **Both `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` were empty in config/.env** on session start. Nathan set `OPENAI_API_KEY` mid-session (TextEdit path after terminal paste mishap). Anthropic key remains unset.

## Files / systems touched
- **Repo files:**
  - `scripts/retry_cuyahoga_unverified.py` — added `--limit` flag for clean chunking
  - `utils/excess_funds_pdf.py` — added parsers for Clermont (tabular), Greene (line-text), Mahoning (line-text, NOK column), Allen (whitespace-cleaning), Tuscarawas (CF-tagged), Geauga (HTML scraper)
  - `scripts/verify_{clermont,greene,mahoning,allen,tuscarawas,geauga}_surplus.py` — new county verifiers
  - `scripts/refresh_surplus_pipeline.py` — Cuyahoga added to `COUNTIES_WITH_LIVE_DOCKET` via delegation; Butler/Franklin still direct
  - `utils/docket_lookup.py` — extended `UnifiedDocketEntry` with `pdf_url`/`pdf_local_path`/`pdf_text`; Franklin adapter now generates stable SHA-1 `external_id` when source is positional
  - `utils/surplus_verify.py` — new `_fetch_matching_event_pdfs()` helper; `SurplusVerifyResult.matching_event_pdfs` added
  - `utils/surplus_docket_pdfs.py` — **rewritten end-to-end**. Removed Claude Vision (~150 lines). Now delegates to `pre_processor.ocr_one_pdf` + `llm_processor.extract_surplus_event_fields`. Added `promote_pdf_to_supabase()` + `supabase_storage_path()`.
  - `utils/pre_processor.py` — **additive**: new `ocr_one_pdf(path) → text` for single-PDF in-memory processing (PyMuPDF first, Tesseract fallback). Existing `Pre_Processor()` directory-scan class untouched.
  - `utils/llm_processor.py` — **additive**: new `extract_surplus_event_fields(text, meta) → dict` with surplus-event prompt (who filed, amount requested, attorney, hearing date, document type). Uses GPT-4o via LangChain (same as existing complaint-extraction). Added `_parse_surplus_response()` helper.
  - `utils/supabase_client.py` — new `insert_surplus_event()` for `surplus_docket_events` table writes
  - `metadata/auction/SURPLUS_COUNTY_SURVEY.md` — **new** — full 88-county classification (10 shipped / 18 ready-to-build / 58 records-request / 2 dead)
  - `metadata/auction/AUDITOR_FALLBACK_METHODOLOGY.md` — **new** — 5-step recipe for counties without clerk lists
  - `docs/SURPLUS_PDF_STORAGE_ARCHITECTURE.md` — **new** — DCC Supabase integration plan + schema docs
  - `docs/PDF_FETCH_TODOS.md` — **new** — per-platform URL extraction work (Hamilton 1.5h, Butler 2h, Cuyahoga 2.5h, Franklin session-cookie bug 30min)
  - `HANDOFF_SURPLUS_FUNDS.md` — updated totals (15 counties / $37.85M / 307 ≥$20k / $13.27M), documented OCR decision + current blocker (Franklin session-cookie bug)
  - `.gitignore` — added `metadata/surplus_docket_pdfs/` (local PDF cache)
  - `.claude/projects/.../memory/feedback_surplus_20k_floor.md` — **new** — never mention sub-$20k
  - `.claude/projects/.../memory/project_surplus_pdf_storage_decision.md` — updated with OCR provider decision + confirmed DCC schema

- **DB migrations:** none (DCC's `surplus_docket_events` + `surplus-pdfs` bucket already provisioned by earlier session)

- **Edge functions deployed:** none (verified existing DCC functions: `attach-docket-pdf`, `extract-document`)

- **External systems:**
  - DCC Supabase (project `rcfaashkfpurkvtmsmeb`) — service-role probe verified schema + storage; 1 test event inserted then cleaned
  - ohio-intel snapshot refreshed 3 times (post-Cuyahoga-retry, post-Clermont/Greene/Mahoning/Allen/Tuscarawas, post-Geauga). 6 new snapshots added to `web/data/surplus/`.

## Open follow-ups
- [ ] ohio-intel session: register 6 new county snapshots (Clermont, Greene, Mahoning, Allen, Tuscarawas, Geauga) in `lib/surplus.ts::SNAPSHOTS` + add tabs in `SurplusClient.tsx::COUNTY_TABS`. Also Montgomery/Lucas/Lake/Medina still pending.
- [ ] Fix Franklin session-cookie bug (~30 min) — PDF fetcher doesn't share disclaimer-acceptance cookie. Scoped in [PDF_FETCH_TODOS.md](docs/PDF_FETCH_TODOS.md).
- [ ] Hamilton URL extraction (~1.5h)