# RefundLocators Business & Technical Transfer Document

**Purpose**: Full knowledge handoff for a new Claude Code project (or a new human owner) to take over RefundLocators' operations without losing context. Read this top-to-bottom on day 1, then keep it open as reference.

**Written for**: Nathan's next Claude Code session (primary), secondarily any future owner or contractor assuming control of the business.

**Date of last full refresh**: 2026-04-20 (end of Session 13).

---

## 1 — Executive Summary

FundLocators LLC is a one-LLC / three-brand Ohio business centered on foreclosure surplus fund recovery for former homeowners. It operates entirely on a custom-built web stack (single-file HTML + Supabase) that Nathan calls the **Deal Command Center** — DCC for short. DCC is designed to scale from "deal tracker" into **the entire operating system of the company**: CRM, document storage, attorney communication, client portal, financials, SOPs, AI workspace, and brand management for all three consumer-facing sites.

The system is usable by four types of people, each with their own app/portal:

- **Team** (admin / VA) → `index.html` (DCC)
- **Homeowner client** → `portal.html`
- **Attorney / counsel** → `attorney-portal.html`
- **Public lead capture** → `lead-intake.html`

Backend is a single Supabase Postgres project with Row-Level Security doing the auth work. Court docket scraping is handled by a separate project called **Castle** that writes into DCC's database. Email comes via Resend, outbound phone is GHL.

The long-term vision Nathan describes: *"one login, everything, sellable as a business."*

---

## 2 — Business Entity Map

### The legal entity
**FundLocators LLC** — Ohio LLC. All business operates under this single entity.

### Doing-Business-As (DBA) designations

| DBA | Purpose | Status |
|---|---|---|
| **RefundLocators** (refundlocators.com) | Primary consumer brand. Covers everything surplus-recovery: SMS funnel top-of-funnel, public lead intake, post-signing client ops, DCC team tooling, attorney portal, engagement letters. This is the name customers and counsel see everywhere. | DBA registration pending with Ohio SoS |
| **Defender Homeowner Advocates** (defenderha.com) | Pre-sale deal activation — working with homeowners *before* foreclosure auction happens | Registered DBA |

### The two consumer-facing websites

| Site | Audience | What it does |
|---|---|---|
| **refundlocators.com** | Former homeowners (surplus recovery) + SEO | Primary brand. Top-of-funnel SMS, lead intake, client portal, attorney portal, DCC entry |
| **defenderha.com** | Pre-auction homeowners | Pre-sale deal activation, help before the hammer drops |

Both brands share one data infra (DCC's Supabase) and one phone number: **(513) 951-8855** (GHL-unified since 2026-04-17).

Unified STOP / opt-out compliance across both brands.

Legal footer pattern: *"RefundLocators, a d/b/a of FundLocators LLC"* — consumer brand forward, LLC preserved for legal disclosure.

---

## 3 — The System Map

### Live URLs

| URL | What it is | Who uses it |
|---|---|---|
| https://thelocatoroffunds.github.io/deal-command-center/ | **DCC** — team admin app | Nathan, VA |
| https://thelocatoroffunds.github.io/deal-command-center/portal.html | **Client portal** | Homeowners who signed with us |
| https://thelocatoroffunds.github.io/deal-command-center/attorney-portal.html | **Counsel portal** | Retained attorneys on specific cases |
| https://thelocatoroffunds.github.io/deal-command-center/lead-intake.html | **Public lead capture form** | Anyone; public URL for marketing |
| `https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/docket-webhook` | **Castle webhook** (Edge Function) | Castle scrapers push docket events here |

### External systems

| System | Purpose | Relationship |
|---|---|---|
| **Castle** | Ohio county docket scrapers | Reads `public.deals` directly; pushes events to DCC webhook |
| **Supabase** project `rcfaashkfpurkvtmsmeb` | Postgres DB + Auth + Realtime + Storage + Edge Functions | Backbone of DCC |
| **Resend** | Outbound email (daily digest, docket notifications, magic links) | API key in Supabase Vault |
| **GHL (GoHighLevel)** | Unified SMS + phone (513) 951-8855 | Outbound number; SMS not yet wired into DCC notifications |
| **GitHub** (`TheLocatorOfFunds/deal-command-center`) | Source code + auto-deploy via GitHub Pages on push-to-main | Any commit to `main` triggers ~30s rebuild |
| **Claude Desktop** + Supabase MCP | Nathan's primary development interface — NOT a deployed service | Nathan prompts, Claude applies migrations / deploys functions |

### The four apps (all live under deal-command-center/)

#### `index.html` — Deal Command Center (team app)
~175KB. React 18 + Babel Standalone + Supabase JS (all CDN). Single-file app.

Admin & VA sign in via magic link. See all deals, edit them, assign team members, attach docs, track expenses (admin only), manage leads, search across deals (⌘K), invite clients/attorneys to their portals, tour the client/counsel portals in admin preview mode, receive daily digest email, see docket events + scraper health.

#### `portal.html` — Client portal
~60KB. Single-file. Cream/navy/gold brand palette.

Homeowners sign in with their email (invite-only via `client_access` table). See their case status, welcome video, payout estimate, attorney assignment, court activity feed, docket event notifications (opt-in email + SMS), two-way messaging with Nathan, document upload. Multi-claimant aware (doesn't leak other claimants' emails).

#### `attorney-portal.html` — Counsel portal
~35KB. Hash-based routing. `#/` inbox, `#/case/:id` detail.

Attorneys sign in, see only cases they're assigned to via `attorney_assignments`. Can post case updates (→ activity feed), upload documents, message the team, see full docket event stream.

#### `lead-intake.html` — Public intake form
~40KB. Public-facing, no auth. Anon key writes directly to `public.leads` with UTM/attribution capture. Full marketing landing page w/ hero, stat strip, FAQ, founder bio, etc.

---

## 4 — People & Roles

| Person | Role | Email | Notes |
|---|---|---|---|
| **Nathan** | Founder, CEO | `nathan@refundlocators.com` | Primary decision-maker. Role: `admin`. |
| **Justin** | Co-founder, developer | `justin@refundlocators.com` | Pushes occasional commits directly via GitHub web UI. Role: `admin`. |
| **Lauren** | AI chat brand voice | — | Referenced in `LAUREN_PROMPT_V2.md` — chat widget brand/copy for refundlocators.com |
| **Jeff Kainiz** | Attorney | — | Referenced on open cases. Uses counsel portal. |
| VAs | Operations | — | Role: `va` — full DCC access except financials. |

### Role model (4-tier, enforced by RLS)

| Role | Who | Access |
|---|---|---|
| `admin` / `user` (legacy) | Nathan, Justin | Full access to everything |
| `va` | Virtual assistants | Everything except `expenses` table + financial fields in `deals.meta` |
| `attorney` | Retained counsel | Only their assigned deals (via `attorney_assignments`) |
| `client` | Homeowners | Only their own deal (via `client_access`), only client-facing data |

SECURITY DEFINER helpers handle role checks:
- `public.is_admin()`
- `public.is_va()`
- `public.is_attorney()`
- `public.is_client()`

The `handle_new_user` trigger assigns role on first sign-in:
1. Email matches pending `client_access` → role `'client'`, links `user_id`
2. Else email matches pending `attorney_assignments` → role `'attorney'`
3. Else → role `'user'` (treated as admin by policies)

---

## 5 — Supabase Project

### Connection info

| Field | Value |
|---|---|
| Project ref | `rcfaashkfpurkvtmsmeb` |
| Project URL | `https://rcfaashkfpurkvtmsmeb.supabase.co` |
| Dashboard | https://supabase.com/dashboard/project/rcfaashkfpurkvtmsmeb |
| Region | (check dashboard) |
| Database URL | `postgres://postgres.[ref]:...@...supabase.com:6543/postgres` (pooled) |

### Keys (in order of sensitivity)

| Key | Where it lives | Who sees it |
|---|---|---|
| **Anon (publishable) key** `sb_publishable_BjBJSBQC2iJXQodut3y3Ag_8aKyPmwv` | Hardcoded in all three HTML apps | Public — it's in the GitHub repo, that's fine |
| **Service role key** | Castle's `config/.env` + Supabase dashboard | DO NOT commit anywhere. Used for cross-RLS writes. |
| **Access token for Supabase MCP** | Claude Desktop config at `~/Library/Application Support/Claude/claude_desktop_config.json` | Nathan's laptop only |
| **DOCKET_WEBHOOK_SECRET** | Supabase Edge Function env vars | Castle has a copy (out-of-band shared). Current value: `83be9a6d78bdf9e69cd80c369b1d153320605ea5fcc33bf7ac7db98393042948` |
| **resend_api_key** | Supabase Vault | Referenced by pg functions for email sends |

### Extensions enabled

- `pg_cron` — scheduled jobs (e.g., daily digest at 12:00 UTC)
- `pg_net` — outbound HTTP from Postgres (for Resend calls)
- `vault` (pgsodium) — secret storage
- `pgcrypto` / `gen_random_bytes` — UUID generation, HMAC

---

## 6 — Database Schema

All tables in `public` schema unless noted. Every table has RLS enabled.

### Core entity tables

| Table | Purpose | Key columns |
|---|---|---|
| `profiles` | 1:1 with `auth.users` | `id` (uuid, FK to auth.users), `name`, `role` |
| `deals` | The core entity (flip / surplus / wholesale / rental / other) | `id` (text PK), `type`, `status`, `name`, `address`, `meta` (jsonb grab-bag), `owner_id`, `lead_source`, `deadline`, `filed_at`, `actual_net`, `closed_at` |
| `expenses` | Per-deal line items (admin-only) | `deal_id`, `category`, `amount`, `date`, `vendor`, `notes` |
| `tasks` | Per-deal todos | `deal_id`, `title`, `done`, `assigned_to`, `due_date`, `priority` |
| `vendors` | Per-deal contractors / contacts | `deal_id`, `name`, `role`, `phone`, `email`, `status` |
| `deal_notes` | Per-deal markdown (unique) | `deal_id`, `body` |
| `activity` | Audit log + event feed | `deal_id`, `user_id`, `action`, `created_at` |
| `documents` | Per-deal file metadata; files in `deal-docs` storage bucket | `deal_id`, `name`, `path`, `size`, `uploaded_by`, `extracted` (jsonb), `extraction_status` |

### Portal access tables

| Table | Purpose |
|---|---|
| `client_access` | Links homeowner emails to deals; `prefs` jsonb holds notification prefs + empathy check-in history |
| `attorney_assignments` | Links attorney emails to deals they're retained on |

### Messaging + leads

| Table | Purpose |
|---|---|
| `messages` | Two-way threads: team ↔ client ↔ attorney per deal. `sender_role` is one of admin/user/va/client/attorney |
| `leads` | Public intake form submissions (anon INSERT allowed via WITH CHECK). Has status flow: new → contacted → qualified → signed / rejected / spam / duplicate. `metadata` jsonb holds UTM attribution + duplicate detection results |

### Docket integration (wired to Castle)

| Table | Purpose |
|---|---|
| `docket_events` | Matched events for each deal. Unique on `(deal_id, external_id)` for dedup. RLS tightly scoped per role |
| `docket_events_unmatched` | Events Castle sent that didn't match any existing deal. Admin reconciles via `reconcile_docket_event` RPC |
| `scrape_runs` | Castle heartbeats (one row per county per monitor run). Feeds the scraper_health view |

### View

| View | Purpose |
|---|---|
| `scraper_health` | Per-county snapshot: last run, last success, events 24h/7d, failures 24h, last status |

### Storage buckets

| Bucket | Purpose |
|---|---|
| `deal-docs` | All deal documents, welcome videos, client uploads, attorney uploads |

### Key RPCs (SECURITY DEFINER)

| RPC | Purpose |
|---|---|
| `is_admin()` / `is_va()` / `is_attorney()` / `is_client()` | Role-check helpers |
| `my_case_claimant_count()` | Client portal: how many claimants on this case (for multi-claimant UI) |
| `client_empathy_checkin(mood, response)` | Client weekly emotional check-in |
| `attorney_post_update(deal_id, note)` | Attorney posts case update to activity feed |
| `attorney_mark_seen()` | Timestamp on attorney_assignments |
| `send_daily_digest()` | Builds + emails the daily digest (runs via pg_cron at 12:00 UTC) |
| `find_lead_duplicates(...)` | Scored match engine across leads + deals |
| `dismiss_lead_duplicates(id, note)` | Mark duplicate warning as reviewed |
| `rescan_lead_duplicates(id)` | Re-run detection after editing a lead |
| `acknowledge_docket_event(id)` | Team marks an event as reviewed |
| `reconcile_docket_event(unmatched_id, deal_id)` | Link a staged unmatched event to a deal |
| `docket_unacknowledged_count()` | For the nav badge |
| `update_client_notify_prefs(email, sms, phone)` | Client updates their notification preferences |
| `dispatch_docket_client_notifications()` (trigger) | Fires on new docket_event INSERT — sends email via Resend, logs SMS placeholder |

---

## 7 — Automations

### Daily digest email (at 12:00 UTC / 8am ET)
pg_cron job `daily-digest-nathan` runs `send_daily_digest()`. Queries stale deals, urgent deadlines, unfiled surplus, bonuses owed, portal activity, monthly metrics. Builds HTML email. Sends via Resend to Nathan.

### Document OCR (on upload)
Edge Function `extract-document` reads images + PDFs, sends to Claude Sonnet 4.5 Vision, returns structured JSON (document_type, confidence, fields, summary, notes). Auto-fires on upload. Stores result in `documents.extracted` jsonb.

### Weekly empathy check-in (client portal)
When > 7 days since last check-in, portal prompts homeowner with mood (good / struggling / need_help) + optional note. Logs activity row on the deal (so Nathan sees it) and appends to `client_access.prefs.empathy_checkins`.

### Welcome video (per-deal)
Stored at `deals.meta.welcome_video.path` in the `deal-docs` bucket. Portal fetches signed URL on load and embeds above the case status.

### Docket event notifications (new)
- Webhook receives event → inserts `docket_events` row
- AFTER INSERT trigger `dispatch_docket_client_notifications` fires
- For client-facing event types (disbursement_ordered/paid, hearing_scheduled/continued, judgment_entered):
  - Emails every enabled `client_access` row via Resend
  - Logs SMS placeholder (real provider not yet wired)
- Test events (`external_id` starts with `test-` or `mock-`) are skipped

### Lead duplicate detection (on intake)
BEFORE INSERT trigger on `leads` → calls `find_lead_duplicates` → populates `metadata.duplicates` + `duplicate_count` if any match. Shows warning banner in DCC.

### Realtime
Postgres logical replication publishes to `supabase_realtime` on: `deals`, `messages`, `leads`, `docket_events`, `docket_events_unmatched`, `scrape_runs`, `activity`. All three portals subscribe.

---

## 8 — External Services

### Resend (outbound email)
- Sender: `hello@refundlocators.com` (domain verified)
- API key stored in Supabase Vault as `resend_api_key`
- Used by: daily digest, docket notifications, magic-link auth
- Fallback for magic-link if Resend fails: Supabase's default SMTP

### GHL (GoHighLevel)
- Unified phone: (513) 951-8855
- Previously fragmented: 513-516-2306 (old Nathan cell), 513-253-1100
- SMS gateway for all three brands
- **Not yet wired into DCC notifications** — SMS preference in client portal logs a placeholder
- Needs: GHL API key + location ID to wire. OR swap to Twilio.

### Castle (docket scraper)
- Separate Python CLI/cron project (not a web service)
- Runs on Nathan's infrastructure (check with Castle team for host details)
- Reads `public.deals` directly using Supabase service key in its `config/.env`
- POSTs events to DCC's Edge Function webhook
- Writes heartbeats to `public.scrape_runs`
- Has 2Captcha dependency for some Ohio counties
- Coverage as of 2026-04-20: Franklin live; Butler / Warren / Cuyahoga 1-2 calibrations away; 74 more counties scaffolded

### Claude API
- Used for document OCR (Claude Sonnet 4.5 Vision)
- Used by Claude Desktop with Supabase MCP for interactive dev
- `ANTHROPIC_API_KEY` stored as Edge Function secret

---

## 9 — Secrets & Credentials Map

**DO NOT COMMIT ANY OF THESE VALUES**. This map describes where they live, not what they are.

| Secret | Home | Used by |
|---|---|---|
| Supabase service role key | Castle's `config/.env`, Supabase dashboard | Castle writes, Edge Functions |
| `ANTHROPIC_API_KEY` | Supabase Edge Function env var | `extract-document` Edge Function |
| `DOCKET_WEBHOOK_SECRET` | Supabase Edge Function env var | HMAC validation in `docket-webhook` |
| `resend_api_key` | Supabase Vault | pg_net calls from daily digest + notifications |
| GHL API key + location ID | **Not yet set** | Future SMS notifications |
| 2Captcha API key | **Not yet set** (Castle side) | Unblocks Butler, Warren, Henschen counties |
| GitHub PAT | macOS Keychain (local) | Git push from Nathan's laptop |
| Supabase MCP access token | `~/Library/Application Support/Claude/claude_desktop_config.json` | Claude Desktop tool calls |

---

## 10 — Brand System

### Palette

| Token | Hex | Use |
|---|---|---|
| `--navy` | `#0b1f3a` | Primary brand color, nav, CTAs |
| `--navy-mid` | `#17355e` | Hover states, gradients |
| `--gold` | `#c9a24a` | Accent, CTA, brand dot |
| `--gold-light` | `#d8b560` | Accent hover |
| `--gold-soft` | `#ede5cf` | Soft gold backgrounds |
| `--cream` | `#fffcf5` | Cream text on navy |
| `--bg` | `#fbf8f1` | Page background (client portal) |
| `--bg-card` | `#ffffff` | Card background (client portal) |
| `--text` | `#1a1a1a` | Body text |
| `--text-muted` | `#6b6b6b` | Secondary text |
| `--green` | `#2d7a4f` | Success, recovered state |
| `--red` | `#a83232` | Error, objection, alert |

**DCC uses dark theme** (stone-900/950 base: `#0c0a09`, `#1c1917`). Client + Attorney portals use **cream/light theme**.

**No red, no bright green, no all-black** per brand non-negotiables.

### Typography

- **Display / headings**: Fraunces (serif)
- **Body**: Inter (sans)
- **Monospace**: DM Mono (for numbers, timestamps, codes)

### Voice

Warm, knowledgeable, approachable. Smart friend who knows the system. Never call-center, government, scammy, or salesy. Core line for refundlocators.com: *"We already know your case. Let us show you what we found."*

### Phone

Always tap-to-call:
- Primary: **(513) 951-8855** (GHL unified)
- Legacy numbers in older docs: 513-516-2306, 513-253-1100 — should be updated when found

### Compliance (refundlocators.com specifically)

Per §12 of the product spec:
- Trade-name disclosure in footer
- "Not attorneys / legal advice" disclaimer
- "Not a government agency"
- STOP / opt-out global across all three brands

---

## 11 — Deployment & Development

### GitHub Pages auto-deploy

- Repo: `github.com/TheLocatorOfFunds/deal-command-center`
- Branch: `main`
- Pages source: root of main
- Rebuild time: ~30-60s after push
- Custom domain: none currently (was `check.refundlocators.com` briefly — removed 2026-04-20)

### Local dev workflow

There is no build step. Files are edited directly and opened via `file://` for testing. Supabase auth + realtime work over file:// during dev.

```bash
# Edit
$ vim index.html

# Test (Mac)
$ open index.html

# Deploy
$ git add index.html && git commit -m "..." && git push
# Wait ~30-60s for GitHub Pages rebuild
```

### When Nathan cannot push (PAT expired)

Happened twice so far. Fix:
1. https://github.com/settings/tokens/new
2. Scope: `repo`
3. Generate, copy
4. Store in macOS keychain: `printf "protocol=https\nhost=github.com\nusername=TheLocatorOfFunds\npassword=<PAT>\n\n" | git credential-osxkeychain store`
5. `git push` works again

### Claude Desktop + Supabase MCP

Nathan's primary dev interface. Config at `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "supabase-dcc": {
      "command": "/Users/alexanderthegreat/.nvm/versions/node/v24.15.0/bin/npx",
      "args": ["-y", "@supabase/mcp-server-supabase@latest", "--project-ref=rcfaashkfpurkvtmsmeb"],
      "env": { "SUPABASE_ACCESS_TOKEN": "<token>" }
    }
  }
}
```

Claude Code / Claude Desktop can then: list tables, apply migrations, execute SQL, deploy Edge Functions, search docs — all without leaving the chat.

---

## 12 — Key Gotchas

These trip people up. Internalize before editing.

1. **Babel-in-browser is slow on cold load** (~1s). Not broken — just patient.
2. **No TypeScript, no linter.** Runtime errors only surface in the console. Test in-browser before committing.
3. **`deals.meta` jsonb is a grab-bag.** Document new fields here. Existing fields include: `county`, `courtCase`, `phone`, `email`, `attorney`, `estimatedSurplus`, `feePct`, `attorneyFee`, `listPrice`, `contractPrice`, `strategy`, `welcome_video`, `bonus_due`, `flagged`, `lead_source`, `from_lead_id`, `intake_notes`.
4. **Status strings are lowercase-with-hyphens** (`under-contract`, `new-lead`). Don't change casing without updating `STATUS_COLORS`.
5. **Deal IDs are text not UUID.** Naming: flips use `flip-<streetnumber>`, surplus cases use `sf-<lastname>` or auto-generated `surplus-<timestamp>`.
6. **The `activity` table is write-heavy.** Every edit logs. Bulk operations should batch.
7. **Cached 301 redirects** — if you ever set a custom domain via Pages Settings + CNAME file and then remove them, browsers cache the 301. Fix: append `?fresh=1` to the URL once to refresh the cache.
8. **Anon key is PUBLIC** — it's in the repo. RLS is what actually protects data. Never put the service-role key in any HTML file.
9. **handle_new_user trigger is fragile** — if email doesn't match pending client_access/attorney_assignments, new user defaults to admin. Tighten eventually.
10. **Two-way messaging RLS** — clients can read their own messages on their deal only; attorneys their assigned; admin all. `sender_role` must be set correctly on INSERT; RLS enforces.

---

## 13 — Strategic Documents Index

Every `.md` and `.txt` file in `/Users/alexanderthegreat/Documents/Claude/deal-command-center/`:

| File | Purpose | Audience |
|---|---|---|
| **`CLAUDE.md`** | AI collaborator primer — what's in here, how it's structured, common change recipes | Any future Claude Code session |
| **`TRANSFER_TO_NEW_CLAUDE_CODE.md`** (this file) | Full business + technical handoff | Transfer / acquisition / new AI project |
| `README.md` | Public-facing repo intro | GitHub visitors |
| `ONBOARDING.md` | New-hire onboarding guide | VAs, Justin-level contributors |
| `ROADMAP.md` | Feature roadmap | Nathan + Justin planning |
| `REFUNDLOCATORS_VISION.md` | 30KB vision doc for refundlocators.com | refundlocators strategy |
| `REFUNDLOCATORS_CONTEXT.md` | 26KB context dump for refundlocators | refundlocators strategy |
| `REFUNDLOCATORS_FUNNEL_PLAN.md` | Funnel strategy | refundlocators marketing |
| `GRAND_SLAM_OFFER.md` | Hormozi-style offer construction | refundlocators sales |
| `LAUREN_PROMPT_V2.md` | AI chat widget brand voice / prompt | refundlocators chat |
| `HANDOFF_FROM_DCC_TO_REFUNDLOCATORS.md` | Earlier cross-project handoff | Refundlocators session |
| `JUSTIN_KICKOFF.md` | Original co-founder kickoff doc | Justin |
| `JUSTIN_CRISTIAN_CALL_AGENDA.md` | Meeting agenda | Team planning |
| `OWNER_MEETING_BRIEFING.md` | Meeting briefing for the owner | Team planning |
| `INFRASTRUCTURE_MAP.md` | Earlier infrastructure map | Operations |
| `CASTLE_DOCKET_INTEGRATION.md` | The Castle ↔ DCC contract | Castle team + DCC team |
| `CASTLE_JOHN_DUNN_PROMPT.md` | Prompt for Castle session on John Dunn case | Castle team |

**Recommendation for new Claude Code sessions**: start by reading `CLAUDE.md` + this file. Other docs are reference, dip in when touching a specific surface.

---

## 14 — Current State (Session-by-Session)

Built chronologically, 13 sessions so far:

- **Session 1**: Foundation — tables, RLS, DCC UI, magic-link auth, deal list + detail
- **Session 2**: Expenses, tasks, vendors, notes, activity feed, realtime sync
- **Session 3**: Dashboard analytics, YTD profit, pipeline stats, cash-flow forecast, bonuses owed, search
- **Session 4**: Document OCR (Claude Vision) + PWA installable apps (manifests + icons)
- **Session 5**: Welcome video, empathy check-in, financial UI gating for VAs
- **Session 6**: Counsel (attorney) portal
- **Session 7**: Two-way messaging (DCC ↔ client ↔ attorney), client uploads, cash-flow forecast
- **Session 8**: Public lead intake form (`lead-intake.html`) + global search (⌘K)
- **Session 9**: Duplicate lead detection (scored engine, trigger, RLS-scoped RPCs) + mobile-first polish for all three portals (16px inputs, bottom-sheet modals, FAB, safe-area insets, tap targets)
- **Session 10**: Admin preview mode for client + attorney portals (no more fake accounts needed to tour the client/counsel experience)
- **Session 11**: Castle docket integration — receiving side (tables, RLS, Edge Function with HMAC validation, dedup, deal matching)
- **Session 12**: Docket UI across all three portals (deal detail Docket tab, DCC scraper health dashboard, client Court Activity card, attorney docket section)
- **Session 13**: Client notification preferences (email + SMS stub) + notification trigger dispatching via Resend + (mid-session) honest correction of fabricated docket data + UI polish

### Commit history (approximate)
- `b69b7bc` — Session 4
- `8b4db53` — Session 5
- `1f0967e` — Session 6
- `8eceba3` — Session 7
- `a7c745b` — Session 8
- `03e7c3d` — CNAME (Justin, mistaken custom-domain attempt)
- `598ae2c` — CNAME removed
- `15ed62a` — Session 9 (mobile + dup detection)
- `df7b021` — Session 10 (admin preview)
- `e105225` — Session 11 (Castle receiving)
- `e47bba7` — Castle spec revision (simpler model)
- `0606c80` — Session 12 (docket UI)
- `0b21b56` — Session 13 (notifications)

---

## 15 — Open Work

### Blocked-on-Nathan

- [ ] Set `DOCKET_WEBHOOK_SECRET` env var in Supabase Edge Function settings (value: `83be9a6d78bdf9e69cd80c369b1d153320605ea5fcc33bf7ac7db98393042948`)
- [ ] Share webhook URL + secret + anon key with Castle team out-of-band
- [ ] Decide: keep smoke-test docket event for Kemper visible, or delete?
- [ ] Provide Kemper Ansel's real email so I can swap `client_access.email` from `nathan@refundlocators.com`
- [ ] Reach out to Kemper warm-style before first real notification lands in his inbox
- [ ] Provide GHL API key + location ID (or Twilio creds) to wire SMS notifications
- [ ] 2Captcha API key — Castle operational concern; unblocks Butler (John Dunn), Warren, Henschen counties

### Blocked-on-Castle

- [ ] Butler County calibration to bring John Dunn case CV-2024-10-2117 online
- [ ] Canned smoke-test event POST against DCC webhook to verify HMAC roundtrip
- [ ] Report back: (a) Butler ETA, (b) event-type classifier readiness, (c) county-specific pain points

### DCC side — known-pending builds
- [ ] Automation trigger: `disbursement_ordered` → client celebration hero + Nathan follow-up task + commission row
- [ ] Automation trigger: `notice_of_claim` → Nathan alert (multi-claimant risk)
- [ ] Automation trigger: `objection_filed` → Nathan alert (contest risk)
- [ ] Daily digest email: new "Docket movement" section
- [ ] Filter `external_id like 'test-%'` out of production UI queries
- [ ] SMS dispatch via GHL/Twilio (once credentials arrive)
- [ ] Email-on-new-client-message → Nathan can reply via DCC MessagesTab (current state: MessagesTab exists in DCC, two-way writing works, but there's no trigger that emails Nathan when a client sends a message — he has to check the UI. TODO: add it.)
- [ ] Castle docket UI pass — verify once real events flow

### UI polish backlog
- [x] Remove `Name - Address` concatenation in DCC deal header (Session 14 — done)
- [x] Make Today dashboard cards clickable (Session 14 — done)
- [ ] Attorney portal notification preferences (attorney should be able to opt-in to email alerts for events on their cases, same pattern as client)
- [ ] SMS stub → real provider

### Strategic / product backlog
- [ ] Post-recovery automation (`paid-out` status → celebration + commission log + 30-day follow-up)
- [ ] Commission / referral tracking table + UI
- [ ] Sender-reply-by-email (Nathan can reply to the docket notification email → DCC captures as message)
- [ ] External_id format normalization for case-insensitive case_number matching

---

## 16 — The Vision Forward: DCC as Business OS

Nathan's stated goal: **"compact our entire business into the Command Center, not just deals … our own Google Drive, our own QuickBooks, our own AI, our own business ideas and goals … we communicate with customers, our clients use the portal, attorneys send their introductory email through the portal, it is our CRM, our business mind, our document storage system. I want to be able to sell this business to someone and literally hand them one login and they have everything and know everything."**

This is a correct and ambitious vision. Treat DCC as the operating system of RefundLocators, not just a tracker. Here's the roadmap to get there.

### Phase 1 — What DCC is today (deals + portals)
✅ Deal pipeline tracking
✅ Client portal + attorney portal
✅ Document storage (per-deal)
✅ Two-way messaging
✅ Lead intake + dedup
✅ Docket event integration
✅ Daily digest
✅ OCR
✅ Admin preview

### Phase 2 — Expand to CRM + Contacts (contacts that aren't deals)

New surfaces needed:
- **`contacts` table**: general CRM entities (potential partners, referral sources, other attorneys, title companies, investors, competitors, press). Not every contact becomes a deal.
- **Contacts tab in DCC**: list, filter by tag/segment, notes, activity log per contact
- **Cross-link**: deals can reference contacts (attorney on a case is a contact), activity can reference contacts

### Phase 3 — Company-wide document storage (beyond deal-docs)

Currently all uploads are per-deal. Expand to:
- **`library` bucket**: company-wide docs (SOPs, contracts, templates, legal forms, brand assets, videos, training)
- **`library_documents` table**: metadata + tags + visibility (admin-only, va+, client-visible)
- **Library view in DCC**: folder-like tree, search, tag filter, version history
- **Embed-by-link into client/attorney portals** so templates flow into comms

This alone replaces Google Drive for 80% of RefundLocators' needs.

### Phase 4 — Financials (QuickBooks alternative)

Tables needed:
- **`transactions`**: all money movements (per-deal expense ties in, but also ops costs, payroll, taxes)
- **`invoices`**: generated from deals + custom
- **`commissions`**: per-deal splits, referral pay-outs
- **`monthly_statements`**: auto-generated P&L

UI:
- Financial tab in DCC (admin-only)
- Monthly P&L view
- Tax-ready export (schedule C, schedule K)
- Per-deal true-up: what we projected vs what we banked

### Phase 5 — Knowledge / SOPs / playbooks

Tables:
- **`sops`**: step-by-step operational docs (e.g., "How to intake a new Ohio surplus lead", "Attorney retainer kickoff checklist")
- **`playbooks`**: more like templates (email templates, call scripts, legal filing templates)
- **`goals`**: OKR-style, linked to time periods

Tight integration: from a deal detail, one-click "use this playbook" — auto-creates the tasks, uses the template for messages, pulls the attorney letter from the library.

### Phase 6 — Business ideas / scratchpad / AI workspace

Tables:
- **`ideas`**: raw capture (tag, status: raw / exploring / validated / shipped / parked)
- **`experiments`**: active hypothesis tests with outcomes
- **`ai_sessions`**: log of Claude conversations Nathan ran against DCC data (so knowledge compounds, not disappears)

Embed Claude directly into DCC (via Anthropic API). A sidebar "Ask DCC" that can answer: *"show me the monthly revenue trend for surplus cases in Hamilton"*, *"what's the average time from signed to recovered?"*, *"draft a reply to this client message"*.

### Phase 7 — Multi-brand management

Tables:
- **`brands`**: RefundLocators / Defender Homeowner Advocates / RefundLocators — each with its own color palette, phone, email signature, legal footer, website
- **Per-deal brand attribution**: which brand owns this deal (affects emails, client portal skin, SOP set)
- **Cross-brand analytics** in DCC: per-brand revenue, LTV, CAC

### Phase 8 — Ownership-transfer layer

Tables / features:
- **`access_grants`**: named login sets — Nathan, Justin, VAs, and the eventual buyer. Each grant has full audit trail, revoke capability
- **`state_snapshot` exporter**: one-click "export everything" for due-diligence: CSV of deals, financial summary PDF, full doc bundle, SOP archive
- **Acquisition-readiness dashboard**: checklist that any prospective buyer sees on day 1 — active case count, pipeline value, monthly revenue run rate, 12-month retention, top referral sources, tech stack inventory, cap table

This is what makes the business sellable with one login.

### Implementation priority I'd recommend

Given Nathan's current revenue engine is surplus recovery, the sequence that maximizes revenue-per-week-of-dev-time:

1. **(Now)** Finish Castle integration end-to-end (Kemper + John Dunn flowing)
2. **(Near)** Post-recovery automation + commission tracking — closes the revenue loop
3. **(Near)** Email-on-client-message → Nathan replies by email OR via DCC — frees up check-the-UI-all-day
4. **(Medium)** Library for company-wide docs — replaces first Google Drive use case
5. **(Medium)** Contacts table + CRM view — replaces spreadsheets
6. **(Bigger lift)** Financials — when the monthly reconciliation pain is worse than the dev time
7. **(Bigger lift)** Multi-brand attribution — when defenderha.com + refundlocators.com each have >20 active deals flowing
8. **(Eventually)** AI workspace, SOP layer, goals — once the above feel solid

---

## 17 — Claude Code Priming Instructions

**To the next Claude Code session picking up this project:**

On your first message with Nathan:

1. Do NOT ask him to repeat context. Read `CLAUDE.md` + this file + the CASTLE spec + the REFUNDLOCATORS docs. You start with full context.

2. Nathan is a non-coder. Respond in business language first, technical language second. When you propose code changes, always explain the "why" before the "what". Never lead with a code block.

3. Nathan prompts; you execute. He's explicitly said: *"I am not a coder. I am a prompter."* Bias heavily toward: do the work, apply the migration, push the code, tell him what happened. Don't ask permission for small changes he's already implied.

4. When he asks for a feature that crosses two brands (DCC + Castle, DCC + refundlocators, DCC + client portal), **stop and check boundaries**. He said earlier: *"I have intertwined this command center chat with refundlocators.com, which was not my intention."* Respect the separation. If work leaks across brands, surface it and ask.

5. Honesty. When you don't know something, say so. When you make a mistake, own it clearly (e.g., Session 13 fabricated docket events — the right response was to apologize, delete, and never do that again). Never dress up fake data as research.

6. He uses `@` emails informally. `nathan@refundlocators.com` is his admin account. Don't assume another email is his just because it's mentioned.

7. Mobile matters. Many users (Nathan + VA + homeowners + attorneys) work from phones. Don't break mobile to fix desktop.

8. Financial UI gating is a hard rule. VAs must never see dollar amounts on deals, expenses, commission. Trust the RLS policies, don't expose in UI.

9. Client portal voice is warm-and-empathetic. Attorney portal voice is direct-and-professional. DCC voice is internal-and-no-nonsense. Don't cross them.

10. When in doubt, default to a commit. Nathan can always revert. The cost of a bad commit is low; the cost of a delayed ship is high.

### First actions to take on a new project

```bash
# 1. Read the primers
cat CLAUDE.md
cat TRANSFER_TO_NEW_CLAUDE_CODE.md

# 2. Verify Supabase MCP is connected
# (ask to list tables; confirm you see ~17 tables)

# 3. Verify GitHub access
git remote -v
git pull

# 4. Confirm you can push (will need fresh PAT from Nathan if keychain is empty)

# 5. Ask Nathan: "I've got context. What's top of mind right now?"
```

---

## 18 — Quick Reference URLs

| Thing | URL |
|---|---|
| DCC (live) | https://thelocatoroffunds.github.io/deal-command-center/ |
| Client portal (live) | https://thelocatoroffunds.github.io/deal-command-center/portal.html |
| Attorney portal (live) | https://thelocatoroffunds.github.io/deal-command-center/attorney-portal.html |
| Lead intake form | https://thelocatoroffunds.github.io/deal-command-center/lead-intake.html |
| GitHub repo | https://github.com/TheLocatorOfFunds/deal-command-center |
| Supabase dashboard | https://supabase.com/dashboard/project/rcfaashkfpurkvtmsmeb |
| Supabase Edge Function webhook | https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/docket-webhook |
| Resend dashboard | https://resend.com/ (log in with Nathan's credentials) |

---

## 19 — Final note

This business is FundLocators LLC. Everything in it — the code, the tables, the brand, the three DBAs, the client portal, the attorney portal, the Castle integration, the docket automation, the financial vision — exists to turn Ohio foreclosure surplus back into money in homeowners' pockets, at transparent fees, through licensed attorneys, with no cold calls and no contracts-to-lock-you-in.

Keep that at the center when weighing any change. *Every* UI decision, *every* trigger, *every* notification cadence should answer: does this make recovering the client's money faster, clearer, less scary, or more honest? If not, don't ship it.

Hand this document to any future owner or any future Claude Code session on day 1. It is the single source of truth.

— End of transfer doc.
