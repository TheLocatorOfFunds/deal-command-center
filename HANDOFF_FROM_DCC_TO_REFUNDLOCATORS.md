# DCC → RefundLocators Handoff Brief

For AI sessions working on **refundlocators.com**. This document exists so the refundlocators build doesn't accidentally rebuild capabilities that already exist in the Deal Command Center (DCC).

**Read this before writing any code that stores a deal, a document, a lead, or an activity event.**

---

## The one-sentence principle

> refundlocators is the **funnel**. DCC is the **system of record**. Deals, docs, activity, assignment, and team workflow live in DCC. SMS state, suppression, bot session state, and ephemeral chat state live in Cloudflare D1 / Workers.

---

## What DCC already does (don't duplicate)

DCC is a live, production-deployed internal operations app. Facts:

- **Live URL**: https://thelocatoroffunds.github.io/deal-command-center/
- **Repo**: https://github.com/TheLocatorOfFunds/deal-command-center
- **Stack**: Single-file React (Babel standalone, no build step) + Supabase + GitHub Pages
- **Supabase project ID**: `fmrtiaszjfoaeghboycn`
- **Auth**: magic-link (passwordless)
- **Used by**: Nathan, Justin, Eric, Inaam — internal team only

### Tables already in DCC (schema `public`)

| Table | What it holds |
|---|---|
| `deals` | Every deal across flip / surplus / wholesale / rental. Has `type`, `status`, `lead_source`, `assigned_to`, `actual_net`, `closed_at`, `meta` (jsonb). |
| `expenses` | Per-deal expense line items |
| `tasks` | Per-deal tasks (done/open) |
| `vendors` | Per-deal vendor contacts |
| `deal_notes` | Per-deal running commentary |
| `activity` | Append-only event log across the whole app (who did what, when) |
| `documents` | File references, paired with the `deal-docs` storage bucket |

### Storage bucket

- `deal-docs` — Supabase Storage. Signed agreements, photos, contracts all land here. Path convention: `{deal_id}/{filename}`.

### Activity log

- Every meaningful action writes a row: status changes, assignments, flag toggles, note additions, deal creation. Realtime to all connected team members.
- refundlocators should append to this — see §4 below.

---

## What refundlocators should DO (the integration points)

### 1. On DocuSign signed → create a deal in DCC

This is the critical hand-off. Execute from a Cloudflare Worker (DocuSign webhook handler). Never from the browser.

```typescript
// In your Cloudflare Worker that receives the DocuSign webhook
import { createClient } from '@supabase/supabase-js';

const dcc = createClient(
  'https://fmrtiaszjfoaeghboycn.supabase.co',
  env.DCC_SUPABASE_SERVICE_ROLE_KEY  // never expose to browser
);

// After validating DocuSign envelope-completed webhook:
const { data: deal, error } = await dcc.from('deals').insert({
  type: 'surplus',
  status: 'signed',              // confirm this exists; if not, use 'new-lead'
  name: signerName,
  address: propertyAddress,
  lead_source: 'refundlocators-sms',  // or -web / -chat per entry point
  meta: {
    refundlocators: {
      chat_session_id: botSessionId,
      castle_lead_id: castleLeadId,
      docusign_envelope_id: envelopeId,
      estimated_surplus: estimatedAmount,
      county: county,
      case_number: caseNumber,
      tcpa_consent_at: tcpaTimestamp,
      bot_transcript_url: transcriptUrl,
      signer_info: { email, phone, state }
    }
  }
}).select().single();

// Upload signed PDF to the deal-docs bucket
const signedPdf = await fetch(docusignDownloadUrl, { headers: authHeaders });
const pdfBytes = await signedPdf.arrayBuffer();
await dcc.storage
  .from('deal-docs')
  .upload(`${deal.id}/agreement-signed.pdf`, pdfBytes, {
    contentType: 'application/pdf',
    upsert: true
  });

// Log the creation event to DCC's activity feed
await dcc.from('activity').insert({
  deal_id: deal.id,
  action: 'Deal signed via refundlocators.com — e-sign completed',
  // profile_id can stay null — this is system activity
});
```

**Why this matters**: DCC's dashboards (Portfolio Stats, Lead Source ROI, Archive view) will automatically include refundlocators deals because they're just regular `deals` rows with a distinguishing `lead_source`.

### 2. `lead_source` values — commit to a convention

Pick from this set, use consistently:

- `refundlocators-sms` — lead came in via SMS bot (inbound)
- `refundlocators-sms-outbound` — lead came from an outbound drip campaign
- `refundlocators-web` — lead submitted the landing page form directly
- `refundlocators-chat` — lead converted inside the chat widget
- `refundlocators-organic` — landed via SEO / direct traffic (no specific campaign)

DCC's ROADMAP.md §2 includes a "Lead source ROI" feature that depends on clean `lead_source` tagging. If you commit to this vocabulary now, you get that dashboard for free later.

### 3. On bot → human escalation → write DCC activity

Whenever the SMS bot or chat bot hands off to a human:

```typescript
await dcc.from('activity').insert({
  deal_id: null,  // no deal yet; pre-qualification stage
  action: `bot escalated — ${reason}`,
  // Surface the reason, severity, phone, transcript URL via a meta column
  // if you add one, or inline in action text for now
});
```

DCC's team can add a filter ("Escalations") later that surfaces these. For now they just appear in the activity feed.

### 4. Suppression list — single source of truth

The spec calls for a cross-brand suppression list (if someone STOPs RefundLocators, they're also suppressed at FundLocators and Defender HA).

**Recommendation**: Put it in DCC Supabase, not D1.

```sql
-- Add to DCC schema
create table public.suppressions (
  id uuid primary key default gen_random_uuid(),
  phone text,
  email text,
  reason text not null,         -- 'STOP' | 'manual' | 'attorney-request' | 'bankruptcy'
  suppressed_at timestamptz default now(),
  suppressed_by uuid references auth.users(id),  -- null if system
  scope text[] default '{refundlocators,fundlocators,defenderha}',
  unique(phone),
  unique(email)
);

-- RLS
alter table public.suppressions enable row level security;
create policy auth_read on public.suppressions for select to authenticated using (true);
-- Writes: service_role only (no user writes needed; bot writes via service_role)
```

**Why Supabase over D1**:
- DCC team gets an admin UI for free (add a "Suppressions" tab to DCC in ~30 min of React).
- One source of truth across three brands.
- Bot reads via the anon key (read-only) before every send — 10ms latency, well under the SMS throughput budget.

If read latency is a problem at scale, Worker can cache hot rows in Workers KV with a 5-min TTL.

### 5. Gift program + subscription records → DCC

Anything with revenue / legal / tax implications goes to DCC. These are audit artifacts.

```
deal.meta.gift_program = {
  enrolled_at, committed_amount, cpa_reviewed_by, attorney_reviewed_by, status
}

deal.meta.subscription = {
  plan, started_at, next_billing_at, status, mrr
}
```

Don't create separate tables yet — `meta` is fine for MVP. Formalize into columns once the feature stabilizes.

---

## What refundlocators should NOT put in DCC

Keep these in Cloudflare D1 / Workers KV / R2:

| Data | Storage | Why |
|---|---|---|
| In-flight SMS conversation state | D1 or Workers KV | Ephemeral, high-read, not a business record |
| Full message log (7-yr retention) | D1 or R2 | Volume too high for Supabase; rarely queried |
| Rate limit counters | Workers KV | Memory-local, high-write |
| Castle API cached responses | Workers cache | Not a record; just a performance optimization |
| Anonymous page visitors (no contact info) | Cloudflare Analytics or PostHog | Not a human yet |
| Bot session transcripts | D1 (link from DCC via URL in `meta`) | Long-form, searched rarely, link to them from DCC |

The rule: **if there's no identified human with TCPA consent, the record is not a DCC candidate.**

---

## Brand context

| Brand | Role in funnel | System |
|---|---|---|
| **refundlocators.com** | Acquisition (post-foreclosure, consumer-direct AI funnel) | New — being built |
| **fundlocators.com** | Acquisition (post-foreclosure, B2B / referral / manual) | Legacy ops |
| **defenderha.com** | Deal activation (post-foreclosure workflow) | Separate product |
| **Deal Command Center** (internal) | System of record for all three brands | Live, shipped |

All three brands feed deals into DCC. The `lead_source` column is how they're distinguished downstream.

---

## Compliance red lines (DCC team has already internalized these)

- Quiet hours: 8am–9pm local to the recipient.
- STOP/UNSUBSCRIBE must suppress across all three brands immediately.
- Bot must disclose it's AI when asked (and proactively on first message).
- "Not attorneys / not a government agency" disclosure on every public surface.
- TCPA consent: captured, timestamped, stored. Exact consent text + IP + timestamp retained.
- Gift program: requires Chris Collins (CPA) + Russ Cope (attorney) sign-off per state.
- 7-year message log retention (regulatory requirement).

---

## Integration credentials refundlocators will need

Store these in Cloudflare Workers env vars / Secrets (never in the repo, never in the browser):

- `DCC_SUPABASE_URL` = `https://fmrtiaszjfoaeghboycn.supabase.co`
- `DCC_SUPABASE_SERVICE_ROLE_KEY` = Nathan/Justin must provision. Find in Supabase Dashboard → Settings → API → `service_role` key. **Treat like a root password.**
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` — after 10DLC A2P registration clears
- `GHL_API_KEY`, `GHL_LOCATION_ID`, `GHL_WEBHOOK_URL`
- `DOCUSIGN_ACCOUNT_ID`, `DOCUSIGN_INTEGRATION_KEY`, `DOCUSIGN_SECRET`
- `ANTHROPIC_API_KEY` — for Claude conversation brain + classifier
- `CASTLE_API_BASE`, `CASTLE_API_KEY`

---

## Reference docs in the DCC repo

Fetch these directly for full context:

- `CLAUDE.md` — DCC architecture + schema + deployment
- `ONBOARDING.md` — how a new contributor gets set up
- `ROADMAP.md` — features already planned for DCC, many of which (Lead Source ROI, Seller Portal, Pipeline Forecasting) will automatically benefit from refundlocators data
- `REFUNDLOCATORS_CONTEXT.md` — the original (now-outdated in places) context brief; **this file supersedes parts of it**

---

## Questions for the DCC side before you ship

Before the first refundlocators → DCC write lands in production:

1. **Add `'signed'` to the surplus `DEAL_STATUSES` enum?** Or use `'new-lead'` and let team promote?
2. **Provision `suppressions` table** — Nathan/Justin will run the SQL.
3. **Generate a DCC service-role key scoped for the refundlocators Worker** — can be the same key DCC uses internally, or a rotated one for isolation.
4. **Agree on `meta.refundlocators.*` shape** — refundlocators proposes it, DCC confirms before first write.
5. **Decide activity feed copy**: what string goes in `action` for bot events? Keep it human-readable so the DCC activity feed stays skimmable.

Resolve these with Nathan before the first DocuSign webhook fires in production.

---

## Changelog

- **2026-04-16** — Written after review of the refundlocators Claude Code session transcript. Aligns the two sides.
