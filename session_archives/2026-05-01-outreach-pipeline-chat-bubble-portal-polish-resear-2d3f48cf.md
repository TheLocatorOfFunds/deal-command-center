---
# Session 2026-05-01 — Outreach Pipeline, Chat Bubble, Portal Polish & Research Agent Design

**Owner:** Nathan
**Source JSONL:** <source>
**Status:** DRAFT (auto-generated backfill, needs review)

## What we set out to do
This was a marathon day-after session continuing work from 2026-05-01 and into 2026-05-05. Nathan drove a sweep across several fronts: auto-trigger SMS drafts on lead prep, add team-chat floating bubble (Eric's request), fix client portal display bugs (John Dunn case), design the FundLocators Research Agent architecture (Ohio Intel → DCC middleware), plus polish pass on portal layout + structure.

## Decisions made (durable — these change behavior going forward)

**Auto-queue Day-0 SMS on Mark Prepped** (PR #74 merged)
- When Eric clicks "✓ Mark prepped" on an A/B-tier lead with phone (no DNC), `markPrepped()` inserts `outreach_queue` row with `cadence_day=0`, `status='queued'` — fires Lauren's draft generator within seconds, no manual click
- Best-effort — gate failures (missing phone, tier C, DNC flag) silently skip, don't break the prep flow
- Day 0 is human-gated (Nathan reviews/sends), drips auto-send starting Day 1 per the `dispatch-cadence-message` ladder

**Drip auto-pause on inbound reply** (recommended to Justin via `@justin-ai` tag, not shipped yet)
- When homeowner replies, all future queued/pending outreach_queue rows for that deal should flip to `status='paused'` so we don't step on a live conversation
- Justin owns the SMS / dispatch-cadence lane — his call on implementation

**Personalized link slugs** (Castle PR #1 merged, backfill complete)
- Butler's minter switched from random nanoid (`K0pRaRQ4`) to name-based slugs (`davidkis`)
- Collision-safe (append `-2`, `-3` as needed)
- 30 homeowner rows backfilled on production including John Dunn → `app.refundlocators.com/s/johndunn` (or /s/davidkis, /s/patriciacatlin, etc.)
- Uglies (address-mixed-into-name like `kemperansel6279parkmeado`) will clean up after Eric's data hygiene pass

**Case Intelligence Apply-to-Details panel** (PR #91 merged)
- Green-bordered **📥 Apply to Case Details** card inside the Case Intelligence section lists AI-extracted facts (sale price, judgment, surplus, plaintiff, judge, etc.) not yet in `deal.meta`
- Per-row Apply / Skip buttons; "Apply all" bulk-patch; conflict detection flags >10% dollar mismatch (e.g. AI surplus $31.5K vs manual $200K)
- `meta.case_intel_skipped` array tracks user-skipped facts so they don't keep nagging
- Source-of-truth ladder: display tiles prefer `meta` over AI extraction (so if Nathan edits Case Details, those values win)

**Client portal consolidated structure** (PRs #93, #95, #96, #98, #100, #101, #104 merged)
- Court Activity + Case Timeline merged into one card — removed duplicate "Case Timeline" section (was ~90% shadow copies of docket events)
- "Documents" card now filters to `uploaded_by IS NOT NULL` (personal client uploads only) — court PDFs linked inline in Court Activity entries via fuzzy-match on `documents` table
- Court Record card redesigned as prose narrative + gold-bordered surplus pull-quote (instead of 5 rainbow tiles)
- CaseHero unified into one flowing card (5 bands: estimated share, tracker, status, what's next, court record) — single shadow, single cream bg, status-driven copy swaps
- No-cache meta tags + `PORTAL_VERSION` stamp at bottom for diagnostic (avoids 10-min GitHub Pages cache surprises)

**Surplus pipeline scaffolding** (PR #38 merged)
- New table `surplus_docket_events` (keyed on `castle_case_id`, not `deal_id` — distinct from active-deal tracking)
- New bucket `surplus-pdfs` (50 MB/file, private, PDF + image types)
- Castle / Ohio Intel surplus writes go here, reusing DCC's extract-document OCR + Lauren pipeline downstream
- Schema mirrors `docket_events` minus deal FK, plus `is_backfill` + `source='castle'`

**FundLocators Research Agent project** (scaffolded, no code yet)
- New project at `~/Documents/Claude/fundlocators-research-agent/`
- `CLAUDE.md` brief lays out architecture: Ohio Intel → Research Agent → DCC, with 3 output paths (Approve / Reject / Needs Human Review)
- Integration list: DCC Supabase, Anthropic, PropStream, IDI Core, Bright Data, 2Captcha, Castle's existing CV3/PROWARE scrapers, Twilio Lookup
- 9 disqualifier checks: bankruptcy, Medicaid lien, multi-heir, sale rescinded, judgment paid pre-sale, LLC owner, owner deceased w/o estate, surplus below threshold, tier demoted below C
- Rollout plan: shadow mode → 10% canary → full rollout
- Next session uses `docs/OPENING_PROMPT_FOR_NEXT_CLAUDE.md` to walk in cold and confirm 8 open questions (PropStream key, IDI Core, surplus floor confirm, where it runs, etc.)

**Floating team-chat bubble** (PR #77, #78, #81, #83 merged — then PR #82 merged Justin's CombinedFAB refactor)
- New 💬 Chat bubble on left edge (Lauren stays right) — click → 380×540 docked panel
- Two modes: thread list (with per-thread unread counts, unread float to top), open thread (last 80 msgs + composer)
- Attachments + linkify URLs in chat (📎 button + auto-anchor `http://...` links in both the bubble and full /team view)
- Sender_kind bug fix: bubble tried to insert `'human'` but the check constraint only allows `'lauren' | 'va' | 'admin'` — fixed by mapping profile.role to allowed values
- Lauren threads filtered out (team bubble only shows non-Lauren threads)

**Tag colors + persistent library** (PRs #52, #58, #75 merged)
- New column `tag_library.color` (gold/red/green/blue/purple/gray), check constraint enforces palette
- DealTagsBar chip rendering + 🎨 click-to-cycle next color in palette order
- Tag library is monotone-additive — removing from a deal doesn't evict from library
- Autocomplete as you type: input filters library suggestions live, "no library match — Enter creates '{tag}' as a new tag" hint

**Advanced Filters** (PR #48 merged)
- 🎚 Filters button on Pipeline filter bar → modal with ~20 field controls (text, money ranges, date ranges, multi-select pills)
- 5 sections: Classification, Identity, Money, Dates, Outreach readiness
- ANDs with existing tier/county/search filters
- Focus-persistence fix (PR #56): hoisted helper components out of `AdvancedFiltersModal` so React didn't unmount inputs on every keystroke

**Conversion Funnel widget** (PR #74 merged)
- New widget on Today view: `91 prep → 23 ready → 0 texted → 0 responded → 0 signed (this week)`
- Each cell click filters the Kanban

**View persistence + auto-refresh** (PR #80 merged)
- Hash encodes current view (`#/view/outreach`, `#/deal/<id>/<tab>`) so Cmd+R stays on the same page
- `deals` re-fetched every 60s + on tab visibility return
- `hashchange` listener syncs state when user hits Back

**Prep Queue** (PR #62 merged)
- New `deals.prepped_at` column + index
- Today view shows **📥 Prep Queue · NEW LEADS TO WORK (N)** above Urgent/Stale
- Auto-derived "missing: phone, tier, URL" hints per row
- ✓ Mark prepped button (green when ready, ghost when incomplete)
-