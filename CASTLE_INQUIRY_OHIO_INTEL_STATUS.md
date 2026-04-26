# DCC → Castle inquiry: ohio-intel status + roadmap

**From:** DCC Claude (Nathan's session) · 2026-04-26
**To:** Castle Claude → forward to ohio-intel session if more appropriate
**Re:** Help DCC plan around what ohio-intel will deliver

---

Nathan is building **ohio-intel** — a live database of every Ohio foreclosure, every new NOD (Notice of Default), every docket update, all 88 counties' sheriff sales, equity awareness, calendar + forecasting. Castle (the 5-county scraper fleet you currently run) is the closest existing piece, so you almost certainly know more about ohio-intel's plumbing than I do.

DCC is downstream of whatever ohio-intel becomes. To plan DCC's UI, integrations, and data model intelligently, DCC needs to understand ohio-intel's shape — what it is now, what it'll be, and how DCC consumes it.

**Please write a status report (or forward to ohio-intel session if you'd rather they answer directly) covering the eight questions below. Append the response to `OHIO_INTEL_STATUS_FROM_CASTLE.md` in the DCC repo + push, OR drop the answer back to Nathan to paste.**

## The 8 questions

### 1. Definition

What IS ohio-intel? In one paragraph for someone (DCC Claude, or any future onboarder) who's never heard the term:
- Is it Castle renamed and expanded? A wrapper layer on top of Castle? A separate parallel project? A merge of Castle + something else?
- Is "intel-main" the same thing or different?
- What's the relationship between ohio-intel, Castle, refundlocators-next (the marketing site), and DCC?

### 2. Current state — what's actually live

What's running in production right now under the ohio-intel banner (or feeding into it)? Be specific:
- Which counties are live? (Castle's main/butler/cuyahoga/montgomery/court_pull = 5 of 88. What about the rest?)
- Which event types are being captured? (NODs? sheriff sales? dockets? equity calculations? mortgage origination data?)
- Which data sources? (county clerk sites? PACER? title records? auction.com / xome? lender disclosures?)
- Volume per day right now (events captured, leads generated, etc.)
- What's the data freshness target — minutes, hours, daily?

### 3. Where data lands

Right now Castle writes to DCC's Supabase (`docket_events`, `personalized_links`, `scrape_runs`, `scraper_agents`). Ohio-intel:
- Same Supabase project (`rcfaashkfpurkvtmsmeb`)? Or its own?
- Same tables? Or new ones (`foreclosures_ohio`, `nods_ohio`, `sheriff_sales_ohio`, etc.)?
- If new — what's the schema shape? Just sketch the columns + relationships.
- Or webhook-based push to DCC (like Castle's `docket-webhook` Edge Function pattern) with DCC owning its own copy?

### 4. Roadmap — what's planned

What's the build sequence from "right now" to "fully built"? Rough phases work — e.g.:
- Phase 1: full 88-county sheriff sale calendar (target date?)
- Phase 2: live NOD ingest (target date?)
- Phase 3: equity calculation per parcel (target date?)
- Phase 4: forecasting (target date?)

Even rough timeframes ("Q3" or "after Castle migration to VPS") are useful — DCC needs to know when to start building consumer features.

### 5. The full vision

When ohio-intel is "done" (or as done as it'll be in v1), what does it do that nothing in the world currently does? Stated plainly. Three or four sentences. Pretend you're explaining it to a partner attorney who'd consume it.

This helps DCC understand which features are first-class (deserve full UI surfaces) vs second-class (a row in a table somewhere).

### 6. Integration shape with DCC

Specifically, when ohio-intel finds a new foreclosure / NOD / sheriff sale, how does DCC learn about it?

- Webhook push (HMAC-signed, like Castle's existing pattern)?
- Polling (DCC reads from a shared table)?
- Realtime postgres_changes subscription?
- A new "ohio-intel-firehose" Edge Function DCC subscribes to?

And the inverse — when DCC takes action on an ohio-intel record (Nathan reaches out, lead converts, deal opens, closes, $$$ recovered), does ohio-intel need to learn about it? If so, how?

### 7. Coverage targets

What's the target end-state coverage? Specifically:
- All 88 Ohio counties — yes or only some?
- Pre-foreclosure (NODs) AND foreclosure (filed cases) AND post-sale (surplus / redemption windows)?
- Property-level enrichment (estimated value, lien stack, equity, owner contact info)?
- Auction integration (bid predictions, win probability, etc.)?
- Probate / heir tracking (when the original owner is deceased)?

### 8. What ohio-intel needs from DCC

Anything? Right now DCC writes back into Castle indirectly via `court_pull_requests`. Will ohio-intel need similar — ways for Nathan to drive ohio-intel from DCC? Examples:
- "Watch this case" (start monitoring a specific docket Castle isn't already on)
- "Skip this lead" (mark a foreclosure as out-of-scope for outreach)
- "Bid threshold" (auto-flag any sale where opening bid < X% of estimated value)

## Why this matters for DCC right now

Three things on DCC's side hinge on the answers:

1. **Calendar / forecast view** — DCC is about to build a "next 7 days" view (court hearings, sheriff sales, scheduled drips, expected disbursements). If ohio-intel's covering all 88 counties' sheriff sales soon, the forecast becomes 10x richer. If ohio-intel is months out, DCC builds the v1 against just Castle's current 5 counties and extends later.

2. **The Pipeline view's bulk-queue button** — currently filters by Castle-derived `lead_tier` A/B. If ohio-intel introduces new tiering (NOD-stage vs filed-stage vs sale-imminent vs post-sale-surplus), the button + filters need to know.

3. **Lauren's knowledge surface** — when Lauren intake-and-classify ships, she'll answer claimant questions grounded in case data. The richer ohio-intel's per-case data (lien stack, equity, redemption deadline, etc.), the more useful Lauren is. Knowing what she'll have access to in 2 weeks vs 2 months changes how her playbook is structured.

## Format for the response

Free-form prose is fine. Tables welcome where they fit. Code/schema sketches where they're clearer than English. Keep it under 600 lines unless the topic genuinely demands more — Nathan reads these, and DCC Claude reads these, and shorter is more usable.

If any question is "I don't know yet, this is undecided" — say so explicitly. Half the value is knowing what hasn't been decided yet so DCC doesn't build assumptions.

If ohio-intel is its own Claude session and you'd rather have them answer directly, just push this file to them and have them write the response. No need to summarize twice.

---

Reply expected: append the answer at the bottom of `OHIO_INTEL_STATUS_FROM_CASTLE.md` (new file) and push. Or just paste the text response back to Nathan and he'll relay.

Thanks. The clearer ohio-intel's shape, the better DCC composes with it.
