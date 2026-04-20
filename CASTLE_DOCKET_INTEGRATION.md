# Castle → DCC Docket Events Integration

**From**: DCC (Deal Command Center) — the team/client/attorney CRM for FundLocators
**To**: Castle — the system that already owns county court docket scrapers
**Purpose**: Get live docket events from Castle into DCC so homeowners, attorneys, and the FundLocators team see real-time case movement.
**Direction**: Castle → DCC (outbound from Castle, inbound to DCC).

---

## TL;DR for the Castle Claude session

DCC needs a webhook event stream of docket updates, scoped to the Ohio surplus cases FundLocators is actively working. Castle reads DCC's `deals` table directly to know which cases to monitor. When an event occurs, Castle POSTs it to DCC's Supabase Edge Function.

Event shape, auth, taxonomy, case-matching, and scraper-health contract are all below.

## Status — decisions locked in (Apr 20, 2026)

- ✅ **Delivery**: webhook (not polling)
- ✅ **Watchlist**: Castle reads `public.deals` directly via Supabase service key — no HTTP API on Castle side
- ✅ **Scraper health**: Castle writes to `public.scrape_runs` — no HTTP health endpoint
- ✅ **Backfill**: Castle CLI command (`--backfill-days N --deal-id X`), not an endpoint
- ✅ **Event type support**: all 12 taxonomy values — Castle ships all of them
- ✅ **external_id format**: Castle's native scheme (must be stable + unique, format doesn't matter to DCC)
- ✅ **Test events**: Castle runs `--dry-run` + `--send-canned` against prod webhook. DCC filters events where `external_id` starts with `test-` out of production UI.
- ⏳ **HMAC secret**: generated, needs to be set in Supabase Edge Function env var + shared with Castle out-of-band

## What's live on DCC right now

- ✅ Supabase tables: `docket_events`, `docket_events_unmatched`, `scrape_runs`
- ✅ RLS policies (admin / VA / attorney / client appropriately scoped)
- ✅ RPCs: `acknowledge_docket_event`, `reconcile_docket_event`, `docket_unacknowledged_count`
- ✅ View: `scraper_health` (per-county dashboard snapshot)
- ✅ Edge Function: `/functions/v1/docket-webhook` (HMAC-validated, dedup-safe, auto-matches deals, stages unmatched)
- ✅ Realtime publication on all three tables
- ⏳ UI: deal detail Docket tab, client portal timeline additions, attorney portal docket tab, scraper-health admin page — all pending Castle delivering real events to test against.
- ⏳ Automation triggers on `disbursement_ordered` / `notice_of_claim` / `objection_filed` — same.

---

## Why this matters

DCC has three audiences:

1. **Team (Nathan + VA)** — need to know when anything moves on any case
2. **Homeowner** (client portal) — needs to see *client-facing* events: "Your hearing has been set for May 15", "The court ordered disbursement of your funds"
3. **Attorney** (counsel portal) — needs the full docket timeline for cases they're retained on

Right now these feeds are manual. Nathan checks dockets, posts updates. This integration automates that.

**The critical event** is `disbursement_ordered` — when the magistrate issues the order releasing surplus funds. Catching this fast triggers the entire payout workflow (client celebration, commission log, bank coordination). If Castle catches nothing else, it should catch this.

---

## Architecture overview

```
┌────────────┐      webhook       ┌────────────────────────┐
│  Castle    │  ─────────────▶    │  DCC Supabase          │
│  scrapers  │     (per-event)    │  /functions/           │
│  (Ohio ct) │                    │   docket-webhook       │
└────────────┘                    │                        │
                                  │   → docket_events      │
                                  │   → activity feed      │
                                  │   → realtime to portals│
                                  └────────────────────────┘
```

**Castle's domain** (unchanged):
- Per-county scrapers, credential management, anti-bot handling, rate limiting
- Case intelligence: surplus estimates, sale dates, equity — already flowing to FundLocators via existing channels
- Docket change detection

**DCC's domain** (this integration):
- Receive events, dedupe, store
- Match events to existing deals
- Surface in team view, client portal, attorney portal
- Trigger downstream automation (payout workflow, status transitions)

**The contract is just the event webhook.** Castle owns everything upstream, DCC owns everything downstream.

---

## Event shape

Every event Castle POSTs should be a JSON object matching this:

```json
{
  "external_id": "hamilton-2024CV12345-000042",
  "case_number": "2024CV12345",
  "county": "Hamilton",
  "court_system": "Hamilton County Court of Common Pleas",
  "event_type": "disbursement_ordered",
  "event_date": "2026-04-18",
  "description": "Magistrate's decision granting disbursement of $34,250 to claimant estate",
  "document_url": "https://courts.hamiltoncounty.org/eFiling/docs/XYZ.pdf",
  "raw": {
    "docket_entry_id": 42,
    "filing_party": "Estate of John Smith",
    "doc_type": "Entry",
    "any": "other data Castle wants to preserve"
  },
  "detected_at": "2026-04-19T14:23:00Z",
  "castle_case_id": "cl_abc123"
}
```

### Field reference

| Field | Type | Required | Notes |
|---|---|---|---|
| `external_id` | string | **yes** | Castle's stable unique ID for this event. DCC uses it as the dedup key. Must never collide across cases. Example format: `<county>-<case>-<ordinal>` but any stable string works. |
| `case_number` | string | **yes** | The court case number. Match against `deals.meta.courtCase`. |
| `county` | string | **yes** | Ohio county name, title case ("Hamilton", not "HAMILTON" or "hamilton"). DCC's UI expects the canonical 88-county name set. |
| `court_system` | string | no | Human-readable name. Shown in UI if present. |
| `event_type` | string | **yes** | One of the taxonomy values (next section). Unknown values default to `docket_updated`. |
| `event_date` | ISO date | **yes** | The docket date (what appeared on the docket), not necessarily when Castle saw it. |
| `description` | string | **yes** | One-line human-readable summary. Shown in timelines. Keep under 240 chars. |
| `document_url` | string | no | Link to the PDF/order if available. DCC will offer to download + OCR. |
| `raw` | object | no | Anything Castle wants to preserve. Opaque to DCC, stored in `docket_events.raw`. Useful for debugging scraper drift. |
| `detected_at` | ISO timestamp | no | When Castle's scraper saw this event. Defaults to server now if missing. |
| `castle_case_id` | string | no | Castle's internal case ID. Optional, useful for cross-reference. |

---

## Event type taxonomy

DCC treats these as the canonical set. Castle should normalize to these wherever possible. Unknown types fall through to `docket_updated`.

| Value | Meaning | Client-facing? | Triggers automation? |
|---|---|---|---|
| `disbursement_ordered` ⭐ | Court orders surplus funds released to claimant | **yes** (celebration) | **yes** (payout workflow) |
| `disbursement_paid` | Funds physically released from escrow | **yes** (celebration) | **yes** (status → recovered) |
| `hearing_scheduled` | New hearing on calendar | **yes** (timeline update) | calendar sync |
| `hearing_continued` | Hearing date moved | **yes** (timeline update) | calendar sync |
| `motion_filed` | Any motion filed (generic) | no (team + counsel only) | none |
| `objection_filed` | Creditor or lienholder contesting claim | no (team + counsel only) | alert Nathan |
| `order_entered` | Court order entered (generic) | conditional | conditional |
| `notice_of_claim` | Another claimant appeared on this case | no (internal alert) | alert Nathan (multi-claimant risk) |
| `continuance_granted` | Case continuance | no | none |
| `answer_filed` | Response/answer filed | no | none |
| `judgment_entered` | Judgment entered | **yes** | conditional |
| `docket_updated` | Generic fallback when we can't classify | no | none |

**Rule of thumb for `event_type`**: if Castle can confidently classify, do. If not, use `docket_updated` with a clear `description`.

---

## Case matching

DCC matches each event to a deal using:

1. **Exact**: `case_number == deals.meta.courtCase AND county == deals.meta.county`
2. **Case-insensitive fallback**: strip non-alphanumeric from both sides and compare

If **no match**: DCC stores the event in a `docket_events_unmatched` table for Nathan to reconcile. These events are NOT lost.

If **multiple matches** (rare — same case, multiple deals): DCC logs a warning and applies to all matches.

Castle does not need to know about DCC's deal IDs. Just send the event with the court's `case_number` and `county`.

---

## Delivery: Webhook (preferred)

### Endpoint — LIVE

```
POST https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/docket-webhook
```

The Edge Function is deployed, HMAC-validated, dedup-safe, and ready to receive events today.

### Headers

```
Content-Type: application/json
Authorization: Bearer sb_publishable_BjBJSBQC2iJXQodut3y3Ag_8aKyPmwv
X-Signature: sha256=<hmac of raw body using shared secret>
User-Agent: castle-docket/<version>
```

**Note on the Authorization header**: `sb_publishable_...` is Supabase's public anon key — it gets the request through Supabase's gateway to the Edge Function. It is NOT your auth. The real auth is the HMAC signature. Treat the anon key as a constant; treat the shared secret as sensitive.

### Body

A single event object (shape above). One event per request. Castle should NOT batch multiple events in one POST unless it's a known-high-volume case — keeps retries clean.

### Auth — HMAC-SHA256

Castle computes:
```
signature = "sha256=" + hex(hmac_sha256(key=DOCKET_WEBHOOK_SECRET, msg=raw_request_body))
```

DCC validates. Mismatched signature returns 401 immediately.

The shared secret `DOCKET_WEBHOOK_SECRET` will be generated by DCC (Supabase Vault) and shared with Castle team out-of-band (Slack, 1Password, not email). **Never commit the secret to a repo.**

### Response codes

| Code | Meaning | Castle should |
|---|---|---|
| 200 | Accepted — `{"accepted": true, "deal_id": "sf-xyz"}` or `{"accepted": true, "unmatched": true}` if no deal found | stop retrying |
| 400 | Bad request (malformed JSON, missing required fields) | log, don't retry |
| 401 | Bad signature | log, alert, don't retry |
| 409 | Duplicate external_id | stop retrying (already seen) |
| 429 | Rate limited | retry with exponential backoff, Retry-After header honored |
| 5xx | DCC server error | retry with exponential backoff, give up after 24h |

### Retry policy

For 5xx and network failures: exponential backoff starting at 30s, max 24h total. After 24h of failures, Castle should log and require manual requeue.

For 200 / 409: stop retrying (success, including dedup).

For 400 / 401: stop retrying (bad data or auth), log + alert.

---

## DCC → Castle: no HTTP API — Castle reads DCC directly

Castle pushed back on the original "Castle exposes HTTP endpoints" design. They're right — it was over-engineered. Castle is a Python CLI/cron tool, not a distributed system, and building FastAPI + auth + deployment for what amounts to a `SELECT` against our deals table added ~3 days of work for no functional gain.

**Revised model**: Castle reads DCC's `public.deals` table directly using the Supabase service key they already have in their config. Every monitor run:

```sql
select
  id          as dcc_deal_id,
  meta->>'courtCase' as case_number,
  meta->>'county'    as county,
  name        as client_name,
  filed_at
from public.deals
where status not in ('paid-out', 'closed', 'dead', 'recovered');
```

That result set IS Castle's watchlist. No registration API, no handshake, no token rotation, no drift risk — the deals table IS the source of truth.

### Implications

| Was | Is |
|---|---|
| DCC calls `POST /cases` when a deal is created | Castle picks up new deals on next cron run (max 1h delay — fine at case-lifecycle timescales) |
| DCC calls `DELETE /cases/:id` when a deal closes | Castle drops the case next run when status transitions to closed |
| Separate `castle_case_registrations` table on DCC | Removed — obsolete. `deals` is the truth. |
| DCC_CASTLE_TOKEN generation/rotation | None. Castle uses the existing Supabase service key. |
| `GET /cases` for reconciliation | Not needed — DCC queries its own deals table. |
| `GET /health` HTTP endpoint on Castle | Replaced by Castle writing to DCC's `scrape_runs` table (see below) |

### Backfill path

Castle exposes no HTTP endpoint for backfill. Instead, Nathan (or a DCC Edge Function in the future) triggers via Castle's CLI:

```
python main.py --step monitor --backfill-days 90 --deal-id sf-smith-lkm3a
```

Castle walks the docket history for that deal and POSTs each event to our webhook as if just discovered. Idempotent via `external_id`.

### scraper_health via scrape_runs table

Castle writes scraper heartbeats directly to DCC's `public.scrape_runs` table after each monitor run. DCC's UI reads from this table for its scraper-health dashboard.

Schema:

```sql
create table public.scrape_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  county text,
  deals_checked int default 0,
  events_found int default 0,
  events_new int default 0,
  status text default 'running',  -- running | success | failed | partial
  errors jsonb default '[]',      -- array of { deal_id?, county?, message, stack? }
  notes text,
  scraper_version text
);
```

Castle writes one row per monitor run per county. Example:

```sql
insert into public.scrape_runs
  (started_at, completed_at, county, deals_checked, events_found, events_new, status, scraper_version)
values
  (now() - interval '45 seconds', now(), 'Franklin', 12, 3, 2, 'success', 'castle-0.8.1');
```

DCC has a view `public.scraper_health` that gives a per-county snapshot (last run, last success, failures in last 24h, events in last 7d) for the admin dashboard.

---


## What Castle needs to know about DCC downstream

For each event received, DCC:

1. **Dedupes** by `(deal_id, external_id)` — safe to retry
2. **Writes** a `docket_events` row
3. **Writes** an `activity` row on the deal (so it shows in the team feed)
4. **Fires realtime** so any team member viewing the deal sees it live
5. **For `disbursement_ordered`/`disbursement_paid`/`hearing_scheduled`/`hearing_continued`/`judgment_entered`**: also surfaces in the client portal timeline (homeowner view)
6. **For `disbursement_ordered`**: triggers the payout workflow (client celebration hero, 24h Nathan follow-up task, commission row)
7. **For `notice_of_claim`**: sends Nathan an alert (multi-claimant risk)
8. **For `objection_filed`**: sends Nathan an alert (contest risk)
9. **If `document_url` is present**: downloads, OCRs via existing Claude Vision pipeline, links to the event

Castle doesn't need to wait for any of this. Fire-and-forget once you get a 200.

---

## Delivery checklist

### Castle's side
- [x] Webhook implementation — half-day build
- [x] Watchlist — query DCC `deals` directly
- [x] Event type support — 8/12 today, remaining 4 (hearing_continued, continuance_granted, answer_filed, judgment_entered) ~30 min
- [x] Rate estimate — 10-20/day steady, 30/hr peak
- [x] County coverage — Franklin live; Butler / Warren / Cuyahoga 1-2 calibrations away; 74 more scaffolded
- [x] Test mode — `--dry-run --webhook-url --send-canned`
- [x] Health — writes to DCC's `scrape_runs` table
- [x] Backfill — CLI command

### DCC's side
- [x] `docket_events` + `docket_events_unmatched` tables (applied)
- [x] `scrape_runs` table + `scraper_health` view (applied)
- [x] Supabase Edge Function `docket-webhook` (deployed, HMAC validated, dedup, deal matching)
- [x] RLS + RPCs (acknowledge, reconcile, unacknowledged count)
- [x] Realtime publication on all three tables
- [ ] HMAC secret set in Supabase Edge Function env vars (Nathan action — blocks live traffic)
- [ ] HMAC secret shared with Castle out-of-band (Nathan action)
- [ ] UI: DCC deal detail Docket tab with unacknowledged badge + acknowledge button
- [ ] UI: client portal timeline additions for client-facing event types
- [ ] UI: attorney portal docket tab on assigned cases
- [ ] UI: admin scraper-health page reading from `scraper_health` view
- [ ] Automation trigger: `disbursement_ordered` → client celebration hero + Nathan follow-up task + commission row
- [ ] Automation trigger: `notice_of_claim` → Nathan alert (multi-claimant)
- [ ] Automation trigger: `objection_filed` → Nathan alert (contest)
- [ ] Daily digest email section summarizing new docket events
- [ ] Filter: `external_id` starting with `test-` excluded from production UI

### Nathan's side
- [ ] Set `DOCKET_WEBHOOK_SECRET` env var in Supabase dashboard
- [ ] Share secret + webhook URL + anon key with Castle out-of-band
- [ ] 2Captcha API key (unblocks Butler + Warren + 10 Henschen counties)

Once Nathan's three items are done, Phase 1 (Franklin + PROWARE counties, ~40% of Ohio foreclosure volume) can flow events into DCC the same week.

---

## Questions to send back

Castle team, please answer these so DCC can finish wiring up:

1. **Webhook or polling?** Which does Castle prefer to build?
2. **Rate estimate** — events per hour per case? Total events per day across all cases?
3. **Event type coverage** — which of the taxonomy can Castle classify? Which fall into `docket_updated`?
4. **County coverage** — which Ohio counties are reliable? Which are sketchy / manual-only?
5. **Document downloads** — does Castle attach PDFs to events or just link to the court's server?
6. **Test environment** — is there a Castle staging instance DCC can point at, or do we go straight to prod?
7. **Any schema overrides** — if your existing internal event format differs from the shape above, name the differences and DCC can adapt (or we'll write a translation layer on the DCC side).

Once Castle answers these, DCC will deploy the Edge Function, generate the shared secret, and share the live URL. Then we can send a test event, verify roundtrip, and flip it on.

---

## Prompt for the Castle Claude session

Copy-paste this when you hand the doc to Castle:

> Here's a spec for wiring up docket events from Castle → DCC (the FundLocators CRM). The document is self-contained — you don't need any other context about DCC to answer.
>
> Read the whole thing, then:
> 1. Tell me which delivery mechanism (webhook vs polling) Castle should build, and what the effort looks like.
> 2. Answer the seven questions at the bottom ("Questions to send back").
> 3. If anything in the event shape or taxonomy conflicts with what Castle already produces, flag it — we can translate on either side.
> 4. Build a minimal version that sends one real event end-to-end against the stub URL for DCC to verify signatures and field shape.
>
> DCC is waiting on your answer before deploying the receiving Edge Function and database migrations. No work on DCC side is blocked on shared secret or production URL — those get generated after you confirm the contract.
