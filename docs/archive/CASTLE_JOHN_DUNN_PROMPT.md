# Castle prompt — wire John Dunn (Butler County)

Second real test case after Kemper Ansel. Copy the "Prompt to paste into the Castle session" at the bottom when you brief your Castle Claude Code.

---

## The case

| Field | Value |
|---|---|
| Client name | John Dunn |
| Property | 8091 Green Lake Dr |
| County | Butler (Ohio) |
| Case number | `CV-2024-10-2117` |
| Deal ID in DCC | `surplus-mo03b7l819tp` |
| Deal status | `signed` |
| DCC `deals.meta.courtCase` | `CV-2024-10-2117` |
| DCC `deals.meta.county` | `Butler` |

## What needs to happen

1. Butler County needs to be online in Castle's scraper rotation. Per your earlier reply, Butler is on the "1-2 calibrations away" list — it's a CourtView system, and Butler is specifically flagged as a 2Captcha-gated county until the calibration unlocks 60 counties.
2. Once Butler scrapes cleanly, Castle's standard monitor loop picks up John Dunn from `public.deals` (because it reads DCC's deals table directly — no separate registration needed).
3. Castle runs its scrape once/day for this case (or the standard cadence you chose — 1/day is fine, match whatever Castle does for other cases).
4. Any new docket movement → POST to the live webhook at `https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/docket-webhook`.
5. DCC receives → matches by `(case_number, county)` → writes to `docket_events` → fires email to the `client_access` row for this deal → event renders in the client portal Court Activity card in realtime.

## Architecture reminder (since you asked "maybe DCC should be the database?")

**Yes — DCC's Supabase project IS the database for all docket data. You don't need a separate one.** Castle is a *stateless producer*. It scrapes, POSTs, and forgets. The data lives in DCC.

Specifically:
- `public.docket_events` — the matched events for each deal
- `public.docket_events_unmatched` — events Castle sent before DCC had a matching deal (staged for Nathan to reconcile later)
- `public.scrape_runs` — Castle's heartbeat ("I scraped Butler at 3:47pm, found 2 events, 1 was new") — feeds the Scraper Health tab in DCC
- `public.deals` — the source-of-truth watchlist Castle reads to know which cases to monitor

Castle owns: scrapers, credentials, CAPTCHA handling, rate limiting, classification.
DCC owns: storage, matching, dedup, UI, notifications, automation.

No second database. The split is pure functional boundaries.

## Before Castle can actually fire

Blocked on:
- [ ] Nathan sets `DOCKET_WEBHOOK_SECRET` in Supabase Edge Function env vars
- [ ] Nathan shares the secret with Castle out-of-band
- [ ] 2Captcha API key for Butler-specific (and Henschen) calibration (ongoing ops, not DCC's concern)

## Prompt to paste into the Castle session

> Second case wired for end-to-end test: **John Dunn — Butler County Ohio, case CV-2024-10-2117**, DCC deal ID `surplus-mo03b7l819tp`.
>
> We've already agreed on the architecture (webhook to DCC, Castle reads `public.deals` directly, writes heartbeats to `public.scrape_runs`) — this case is the second real target behind Kemper Ansel's Franklin County case.
>
> Specifically for John Dunn:
>
> 1. Prioritize getting Butler County online in Castle's scraper rotation. Butler is CourtView and currently 2Captcha-gated per your last update.
> 2. Once Butler scrapes, the standard monitor loop will pick up John Dunn automatically from `public.deals` (no registration needed).
> 3. Confirm you can classify Butler County docket entries into our 12-event-type taxonomy (see `CASTLE_DOCKET_INTEGRATION.md`). The most important events for John Dunn at this stage are `motion_filed`, `hearing_scheduled`, `order_entered`, and eventually `disbursement_ordered`.
> 4. Once scrape-capable, send ONE canned test event against `https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/docket-webhook` using Butler-County-style `external_id` format and an `event_type` of `docket_updated` with a clear "[CASTLE SMOKE TEST]" marker in the description. DCC filters anything with `external_id` starting with `test-` so the smoke won't reach the real client — but we still want to verify HMAC roundtrip and field shape on a real case number.
> 5. Once the smoke passes, flip this case to production-monitoring. Daily scrape cadence is fine.
>
> Blocked only on: (a) `DOCKET_WEBHOOK_SECRET` being set by Nathan + shared to you, (b) 2Captcha key on your side. Both are operational and not code-blocking — you can build the test harness now and flip it live when the secrets land.
>
> Report back: (a) ETA on Butler calibration, (b) confirmation the 12-type classifier handles Butler's entry formats, (c) any Butler-specific scraper pain points.
