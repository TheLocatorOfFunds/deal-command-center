# Castle → DCC Docket Events Integration

**From**: DCC (Deal Command Center) — the team/client/attorney CRM for FundLocators
**To**: Castle — the system that already owns county court docket scrapers
**Purpose**: Get live docket events from Castle into DCC so homeowners, attorneys, and the FundLocators team see real-time case movement.
**Direction**: Castle → DCC (outbound from Castle, inbound to DCC).

---

## TL;DR for the Castle Claude session

DCC needs a webhook event stream of docket updates, scoped to the Ohio surplus cases FundLocators is actively working. For each case we send you (case_number + county), Castle should monitor the docket and POST events to our Supabase Edge Function as they happen.

Event shape, auth, taxonomy, and case-matching contract are all below. At the bottom is a checklist of what to send back so DCC can wire up the receiving side.

**If you can't do webhooks**, a polling endpoint `GET /docket/events?since=<ts>` works too — section "Polling fallback" below.

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

## DCC → Castle: outbound API Castle must expose

For DCC to tell Castle which cases to monitor, Castle needs to expose an HTTP API. This is the reverse direction from the webhook above.

**Base URL**: Castle team provides (e.g. `https://castle.example.com/api/v1`).
**Auth**: `Authorization: Bearer <DCC_CASTLE_TOKEN>` — Castle generates a token for DCC, shared out-of-band.

### Required endpoints

#### `POST /cases` — register a case for monitoring

When FundLocators signs a new client and creates a deal, DCC calls this to tell Castle "watch this case."

```
POST /cases
Content-Type: application/json
Authorization: Bearer <DCC_CASTLE_TOKEN>

{
  "case_number": "2024CV12345",
  "county": "Hamilton",
  "dcc_deal_id": "sf-smith-lkm3a",
  "client_name": "Jane Smith",
  "filed_at": "2026-02-14",
  "priority": "normal"
}
```

Response 200:
```json
{ "castle_case_id": "cl_abc123", "status": "monitoring", "registered_at": "2026-04-20T14:23:00Z" }
```

DCC stores `castle_case_id` in `castle_case_registrations.castle_case_id`.

#### `DELETE /cases/{castle_case_id}` — stop monitoring

When a deal closes (recovered / dead / closed), DCC tells Castle to stop watching.

Response 204.

#### `GET /cases` — list everything Castle is currently monitoring

Used for nightly reconciliation (DCC confirms Castle's list matches DCC's open deals).

Response:
```json
{
  "cases": [
    { "castle_case_id": "cl_abc123", "case_number": "2024CV12345", "county": "Hamilton",
      "registered_at": "2026-04-20T14:23:00Z", "last_event_at": "2026-04-19T10:15:00Z",
      "health": "healthy" }
  ]
}
```

#### `POST /cases/{castle_case_id}/backfill` — one-time historical sync

When a new case is added mid-lifecycle and DCC wants all historical docket entries.

```
POST /cases/cl_abc123/backfill
{ "since": "2025-01-01" }
```

Castle POSTs each historical event to the webhook as if it just happened. Response 202 Accepted.

#### `GET /health` — per-county status

For DCC's scraper-health dashboard.

```json
{
  "status": "ok",
  "counties": {
    "Hamilton":   { "last_successful_scrape": "2026-04-20T13:45:00Z", "healthy": true },
    "Franklin":   { "last_successful_scrape": "2026-04-20T13:40:00Z", "healthy": true },
    "Cuyahoga":   { "last_successful_scrape": "2026-04-18T09:00:00Z", "healthy": false, "error": "captcha_required" }
  }
}
```

### Error shapes

All non-2xx responses should return:
```json
{ "error": "case_not_found" | "county_unsupported" | "duplicate_registration" | "rate_limited" | "internal",
  "message": "human-readable detail" }
```

### Who builds what

- **Castle**: the HTTP endpoints above + the docket webhook integration.
- **DCC**: a small Supabase Edge Function `castle-client` that wraps these endpoints, called whenever DCC creates/closes a deal. DCC will not build this until Castle confirms the API shape + shares `<DCC_CASTLE_TOKEN>`.

---

## Polling fallback (if webhooks are slow to set up)

Castle exposes:

```
GET https://castle.example.com/api/v1/docket/events?since=<ISO timestamp>&cases=<comma-list>
Authorization: Bearer <DCC_CASTLE_TOKEN>
```

Response:
```json
{
  "events": [ { ...event shape above... }, ... ],
  "cursor": "2026-04-19T15:00:00Z"
}
```

DCC polls every 15 minutes with `since=<last cursor>` and processes the returned events identically to webhook POSTs.

Either webhook OR polling is fine — pick whichever Castle can build faster. Webhook is preferred for latency (the `disbursement_ordered` event is time-sensitive).

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

## Delivery checklist — what Castle must provide

To turn this on, Castle team needs to deliver:

- [ ] **Webhook implementation** (or polling endpoint URL)
- [ ] **List of cases Castle is monitoring**, in JSON format:
  ```json
  [
    {"case_number": "2024CV12345", "county": "Hamilton", "castle_case_id": "cl_abc"},
    ...
  ]
  ```
- [ ] **Event type support** — minimum: `disbursement_ordered`, `hearing_scheduled`, `docket_updated`. Stretch: the full taxonomy above.
- [ ] **Rate expectations** — what's the peak event volume Castle might send per hour?
- [ ] **Scraper coverage** — list of Ohio counties Castle can reliably scrape. For uncovered counties, DCC falls back to manual Nathan-posts-updates.
- [ ] **Test mode** — can Castle send a test event DCC can verify signatures + field shape against before going live?
- [ ] **Health endpoint** — way for DCC to know Castle's scrapers are still running (e.g., `GET /health` returning last-successful-scrape-per-county timestamps). Optional but great for debugging.
- [ ] **Backfill capability** — one-time "send all events from past 90 days for case X" endpoint, for onboarding new cases.

---

## What DCC will build on its side (after Castle confirms the contract)

1. `docket_events` table + `docket_events_unmatched` staging table
2. Supabase Edge Function `docket-webhook` — HMAC validation, dedup, deal matching, event routing
3. Automation hooks for `disbursement_ordered`, `notice_of_claim`, `objection_filed`
4. Client portal timeline additions for client-facing events
5. Attorney portal docket tab showing full timeline
6. DCC deal detail Docket tab with unacknowledged count + acknowledge button
7. Daily digest email section summarizing new docket events
8. Integration tests with Castle's test endpoint

DCC will share the exact webhook URL and the shared secret once the Edge Function is deployed. Until then, Castle can build against a stub URL.

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
