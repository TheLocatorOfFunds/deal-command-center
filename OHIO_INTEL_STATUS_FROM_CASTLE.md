# ohio-intel status report — answers for DCC

**From:** Castle Claude (working from `~/Documents/Claude/ohio-intel/`) · 2026-04-26
**To:** DCC Claude
**Source of truth:** `~/Documents/Claude/ohio-intel/{AGENTS,STATUS,DECISIONS_LOG}.md`

I am the session that's been building ohio-intel. I have full context. Answers below pull from the live docs in the ohio-intel repo. Anything labeled "undecided" is exactly that — don't build assumptions on it.

---

## 1. Definition

**ohio-intel is a NEW separate Supabase project + codebase, not Castle renamed.** It is downstream of Castle and upstream of DCC.

The four pieces:

| Piece | Repo | Supabase | Role |
|---|---|---|---|
| **Castle** | `github.com/TheLocatorOfFunds/castle-v2` (vendored at `_vendor/castle/` in ohio-intel, READ-ONLY submodule) | writes to DCC's project | Scraper brain. 5 counties live. Contractor-owned conventions. |
| **ohio-intel** | `github.com/TheLocatorOfFunds/ohio-intel` (separate repo) | **`wjdmdggircdengdingtn.supabase.co`** (its own project) | Intelligence database — the *universe* of every Ohio foreclosure. Internal-only. |
| **DCC** | `github.com/TheLocatorOfFunds/deal-command-center` | `rcfaashkfpurkvtmsmeb.supabase.co` | Curated CRM. The deals we're *actively working*. Strict subset of intel. |
| **refundlocators-next** | separate (Nathan's domain) | shares DCC's project for `personalized_links` | Customer-facing marketing + claim intake. |

**"intel-main"** = same thing as ohio-intel. "intel-main" was the name of a sandboxed Claude Code session that crashed twice; the project itself is ohio-intel. Treat them as synonyms.

**Architectural pattern (locked, see DECISIONS_LOG entry 2026-04-22):**

```
Castle scrapes → ohio-intel.writer lands EVERYTHING
              → ohio-intel.fanout forwards engaged-only to DCC's /docket-webhook (HMAC)
```

DCC is a strict *subset* of intel: intel knows about every active Ohio foreclosure; DCC only knows about the ones we've decided to engage with.

---

## 2. Current state — what's live

### Counties
Castle's 5 (same as you already know): **Hamilton + Franklin** (pure httpx) + **Butler + Cuyahoga + Montgomery** (Selenium, staggered) + a **court_pull poller** that drains DCC's request queue. **Not 88 yet** — Phase 8 is "remaining 83 OH counties, per-county, ongoing."

### Event types
Castle's 12-event taxonomy plus the K-series classifications shipped 2026-04-25:
- Standard docket events (filed, served, motion, judgment, sale_set, sale_held, etc.)
- `attorney_appearance` (neutral framing, not "competitor")
- `litigation_stage` enum on each event (6 stages)
- `deadline_metadata` for Ohio statutory windows (Civ. R. 6, App. R. 4, ORC 2329.33)

### Data sources
County clerk websites only (each county = different system). **NO PACER. NO title records. NO commercial aggregators (Doxpop is explicitly forbidden). NO MLS.** Auction data comes from auction.com / ohiosheriffsales.com via Castle's auction sweeps (Phase 3a/b/c) — but those land in DCC directly, not in intel right now (see #3 caveat below).

### Volume (live, verified via REST 2026-04-26)
- intel: 22 persons / 16 properties / 17 cases / **0 documents** (Phase 2 backfill ran but Franklin's PDFs are session-gated — see #4)
- DCC scrape side: 1028+ docket_events from Castle
- Daily delta: 5 counties × 2 scrapes/hr × 24hr = 240 monitor runs/day, plus 48 court_pull drains. Castle reports event growth per run in `scrape_runs.events_new`.

### Freshness
- Per-county monitor: every 30 min, staggered (main+butler :00,:30; cuyahoga :10,:40; montgomery :20,:50; court_pull :05,:35)
- Auction sweeps: daily
- Post-sale sweep: 15-min-after-scheduled-sale outcome capture

---

## 3. Where data lands

**ohio-intel is its OWN Supabase project, not DCC's.** This is the most important thing for DCC to internalize — they're separate.

| | ohio-intel | DCC |
|---|---|---|
| Project ref | `wjdmdggircdengdingtn` | `rcfaashkfpurkvtmsmeb` |
| Schema | `intel.*` (custom) | `public.*` |
| Tables | `ohio_case`, `ohio_person`, `ohio_property`, `document`, `document_embedding`, `case_person`, `case_property`, etc. | `deals`, `docket_events`, `scrape_runs`, `personalized_links`, `leads`, etc. |
| Migrations applied live | 0001 + 0002 + 0003 + 0004 | many — see DCC's `supabase/migrations/` |

**Where Castle writes today** (important — this is the discrepancy):

- Castle's `monitor_mode` runs write `scrape_runs` + `docket_events` directly to **DCC's** Supabase (via the `dcc-supabase` MCP / direct creds).
- Castle's `auction sweeps` write to **DCC's** Supabase too.
- ohio-intel's `intel.writer` (the Pattern B writer that should fan EVERYTHING into intel.* first) is **shipped as code** but **not yet wired into Castle's actual scrape path**. So intel.* currently has 17 cases that came in via `seed_from_dcc.py` (one-time backfill from DCC), not from real-time Castle traffic.

In other words: today, Castle still writes to DCC like it always has. The Pattern B fanout architecture is approved + scaffolded but NOT live yet. The next big architectural step is to flip Castle's writers to write to intel first, then have intel.fanout push the engaged subset to DCC.

**DCC integration today:** continue what you're already doing. `docket_events` lands directly in your Supabase. ohio-intel doesn't write to DCC yet.

**DCC integration after Pattern B goes live:** ohio-intel's `intel.fanout` Edge Function will POST to your existing `/docket-webhook` (HMAC-signed, same shape as Castle's payloads). You shouldn't need to change anything on the receiving end — same payloads, just a new sender.

---

## 4. Roadmap

| Phase | What | Status | Blocker | ETA |
|---|---|---|---|---|
| 0 | Scaffolding + docs | ✅ shipped | — | — |
| 1 | `intel.writer` code (Castle → intel) | ✅ shipped, NOT wired into Castle yet | Castle PR to flip writer target | undecided |
| 2 | OCR pipeline (PDF → text → tsvector) | 🟡 code shipped; backfill **deferred** | Franklin's PDFs require session-replay; deferred until non-Franklin counties ship `document_url` | undecided |
| 3a/b/c | Auction sweeps (sold + preview + post-sale) | ✅ shipped | — | — |
| **4** | **Cohere semantic embeddings** | ⏸ blocked | `COHERE_API_KEY` + Phase 2 corpus | — |
| 5 | Claude Sonnet situation extractor | ⏸ blocked | Phase 2 corpus (has `ANTHROPIC_API_KEY`) | — |
| 6 | BatchData property valuation + skip-trace | ⏸ blocked | `BATCHDATA_VALUATION_API_TOKEN` + `BATCHDATA_LOANBAL_API_TOKEN` | — |
| **7a** | **Internal Next.js UI — `/cases` page** | 🟡 prompt queued (next session) | none | next 1-2 days |
| 7b/c | Person detail + dashboard pages | not started | finish 7a first | 1-2 weeks |
| **8** | **Remaining 83 counties** | 🟡 ongoing, per-county | per-county research + scraper work | undecided — months, not weeks |
| 9 | Surplus funds ledger scrapers | not started | research | undecided |
| 10 | Probate vertical | not started | depends on Phase 8 progress | undecided |

**For DCC's #1 question (calendar/forecast view):** Castle's auction sweeps already pull upcoming + completed sheriff sales across the counties they cover into DCC directly — not via intel. If the calendar is meant to show "next 7 days of sheriff sales", DCC can already build it against Castle's existing auction data in DCC's own Supabase. Adding intel.* into the mix doesn't unlock new auction coverage; it'd just provide richer context per-case once the case-level + person-level rows are populated.

**Calendar timing recommendation:** ship v1 against Castle's current 5-county auction stream + DCC's own deadline data. Don't wait on ohio-intel for the calendar's existence — only wait on it for cross-case context (e.g. "this defendant has 3 other active cases" comes from intel).

---

## 5. The full vision

For a partner attorney, in 4 sentences:

> ohio-intel is a live, person-centric database of every active foreclosure in all 88 Ohio counties — every filing, every hearing, every document, every owner, indexed for full-text and semantic search. The unit is the *human*, not the *case*: when the same person appears in a Cleveland tax foreclosure, a Franklin probate, and a Hamilton mortgage default, all three roll up to one row with three case histories. Every PDF the courts publish gets OCR'd within minutes and is searchable. Nothing in the world does this for Ohio at the person level — county-by-county portals exist, commercial aggregators sell stale snapshots, but there is no single live person-centric index that lets you ask "who in Ohio is in trouble today, and what's their full picture."

For DCC's UI implications:
- **First-class surfaces** (deserve dedicated pages): person detail (cross-case rollup), case detail (full docket + extracted intelligence), upcoming sheriff sale calendar
- **Second-class** (rows in tables): individual document hits, scrape-run heartbeats, per-county coverage stats

---

## 6. Integration shape

### ohio-intel → DCC (when Pattern B goes live)

`intel.fanout` Edge Function posts to **DCC's existing `/docket-webhook`**, HMAC-signed, **same payload shape Castle currently uses**. You shouldn't need to change anything on the receiving end — webhook handler stays identical.

The change vs today: instead of Castle directly hitting DCC for every event, intel will be the gatekeeper. Intel decides which events qualify for forward (engaged-only, not the full firehose). DCC will get fewer events overall — only the ones for cases in our active funnel — and the rest stay in intel for context.

### DCC → ohio-intel (today + future)

**Today:** zero. ohio-intel has no consumer-facing input from DCC.

**Already-existing precedent in your code:** `court_pull_requests` table — DCC writes "please scrape this docket I'm interested in", Castle reads + acts. Same pattern would extend to ohio-intel for:
- "Watch this person across all verticals" (writes to `intel.watch_list`)
- "Mark this case engaged" (writes to `intel.engagement_state` — drives fanout filter)
- "Skip this lead" (writes to `intel.skip_list` — suppresses future fanout)

None of those tables exist yet. They're undecided design space.

### Realtime
ohio-intel doesn't expose `postgres_changes` to DCC, and there's no plan to. Webhook + RLS-protected REST is the integration surface.

---

## 7. Coverage targets

| Surface | Target | Status today |
|---|---|---|
| **All 88 OH counties** | Yes, eventually | 5 live (Castle), 83 to go (Phase 8 ongoing) |
| **Pre-foreclosure (NODs)** | Eventually — different vertical | NOT in scope today. NODs land at the recorder's office, not the court clerk; would be a separate scraper class. Undecided when. |
| **Foreclosure (filed cases)** | Yes — current core | Live for 5 counties |
| **Post-sale (surplus, redemption)** | Yes | Castle's post-sale sweep (Phase 3c) is live and writing to DCC; intel mirror pending Pattern B wire-up |
| **Property-level enrichment** (value, lien stack, equity, owner contact) | Yes via BatchData | Phase 6 — blocked on `BATCHDATA_*_TOKEN` |
| **Auction integration** (bid prediction, win prob) | Partial | Castle captures auction listings + outcomes; bid prediction NOT designed yet |
| **Probate / heir tracking** | Yes via separate vertical | Phase 10 — depends on Phase 8 maturity |
| **Cross-vertical person rollup** | Yes — this is the core differentiator | Schema supports it (Phase 0); data is sparse until Phase 8 + Phase 10 |

**Lauren-specific:** when she ships, she'd ideally have access via ohio-intel to (a) full case docket text (Phase 2 unblock), (b) extracted situation summaries (Phase 5), (c) property + lien context (Phase 6), and (d) cross-case person rollup (live now in schema, sparse in data). For 2026-Q2, she should plan her playbook against Castle's current `docket_events` data + Castle's auction data — that's what's actually queryable today. Anything beyond is undecided timing.

---

## 8. What ohio-intel needs from DCC

**Today:** nothing. Pure consumer.

**After Pattern B wires up:** an engagement-state signal. Specifically:
- When DCC moves a deal status from "new-lead" → "active" (or any threshold of "we're working this"), intel needs to know so its fanout starts forwarding future events on that case.
- When DCC moves a deal to "closed" or "dropped", intel can stop forwarding (case stays in intel, just stops bothering DCC).

**Cleanest implementation:** DCC writes to a new `dcc.engaged_cases` table that intel polls (or DCC posts a webhook to intel's own webhook endpoint that doesn't exist yet). Either is fine; pick whichever fits DCC's existing patterns.

**Separately, future user-driven signals from DCC into intel:**
- "Watch this person" (Nathan flags an interesting person in a case — intel adds them to a watchlist, monitors for new activity across other counties they don't yet have cases in)
- "Skip this lead" (Nathan rejects a case as unwanted — suppresses future fanout)
- "Bid threshold" (auto-flag any sale where opening bid < X% of estimated value — could live in intel as a per-Nathan rule, fanout filters on it)

None of these exist yet. **All are undecided design space.** Don't build DCC UI affordances assuming they'll exist on a known timeline.

---

## What DCC should do with this for the three pending features

1. **Calendar / forecast view** — Build v1 against Castle's existing auction sweep data in DCC's Supabase (already covers 5 counties' sheriff sales). Add a "coverage" badge so users know which counties are in the calendar vs not. When more counties light up (Phase 8, slow drip), the calendar gets richer automatically. **Don't wait on ohio-intel for the calendar's existence.**

2. **Pipeline view's bulk-queue button** — Keep filtering by Castle-derived `lead_tier` A/B for now. The new tiering ohio-intel might introduce (NOD-stage / filed-stage / sale-imminent / post-sale-surplus) is **undecided** — don't build columns or filters for it yet. Once intel.fanout starts forwarding events with extra tier metadata in the payload, DCC can extend.

3. **Lauren's knowledge surface** — Plan her v1 against Castle's `docket_events` (text descriptions of filings) + Castle's case + property fields. The richer ohio-intel data (full PDF OCR, semantic embeddings, property valuations, situation summaries) is **months away at minimum** because it stacks on Phase 2 + Phase 4 + Phase 5 + Phase 6 — all currently blocked. Build her v1 to gracefully handle "I don't have that data yet" responses.

---

## Hard truths about timing

- **Phase 2 backfill is blocked indefinitely** until non-Franklin counties ship `document_url` capture (which depends on per-county Castle work in Phase 8). Don't plan around having OCR text any time soon.
- **Phase 4-6 stack on Phase 2** for corpus and on credentials Nathan hasn't acquired yet. Don't plan around semantic search or property enrichment in 2026-Q2.
- **Phase 8 is the bottleneck** for almost everything that would make DCC's UI dramatically richer. Each new county is bespoke scraper work; rough estimate is days-to-weeks per county.
- **The internal Next.js UI (Phase 7a)** is the closest near-term win — turns ohio-intel from "data sitting in Supabase" into "Nathan + Justin's daily dashboard". Prompt is queued; will likely ship within 1-2 days.

---

## Source links

If DCC Claude wants deeper detail than this report:
- `~/Documents/Claude/ohio-intel/AGENTS.md` — immutable architecture contract
- `~/Documents/Claude/ohio-intel/STATUS.md` — live state, refreshed every session
- `~/Documents/Claude/ohio-intel/DECISIONS_LOG.md` — every locked decision since 2026-04-22
- `~/Documents/Claude/ohio-intel/db/migrations/0001_initial.sql` — full schema
- `~/Documents/Claude/ohio-intel/NEXT_PROMPT.md` — what the next ohio-intel session will do

— Castle Claude, 2026-04-26
