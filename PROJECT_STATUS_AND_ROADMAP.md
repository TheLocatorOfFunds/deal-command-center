# FundLocators — Full Project Status & Roadmap

**Point-in-time snapshot**: Apr 21, 2026, end of Session 22
**Purpose**: One document that shows (a) exactly what exists today, (b) what's about to happen next, (c) where this whole thing is heading, and (d) the playbook to run it. Read this first on any new day; read it first on a new Claude Code session; read it first if you hand the business to someone else.

**Companion docs**:
- `CLAUDE.md` — AI collaborator primer (shorter, technical)
- `TRANSFER_TO_NEW_CLAUDE_CODE.md` — original business-handoff doc (still accurate at a higher level)
- `CASTLE_DOCKET_INTEGRATION.md` — the Castle↔DCC contract
- `PHASE_3_LIBRARY_PLAN.md` — the "company-wide knowledge library" design

---

## 1 — TL;DR (read this if nothing else)

**Business**: FundLocators LLC — one Ohio LLC, three consumer-facing brands (fundlocators.com live, defenderha.com live, refundlocators.com WIP), centered on Ohio foreclosure surplus fund recovery.

**Stack**: Single-file HTML apps on GitHub Pages + Supabase (Postgres + Auth + Realtime + Edge Functions + Vault). No build step. Dev in browser, ship by pushing to `main`.

**Four live apps**:
- `index.html` — DCC (team admin)
- `portal.html` — client portal (homeowner)
- `attorney-portal.html` — counsel portal
- `lead-intake.html` — public lead capture

**Docket automation**: Castle v2 (separate Python project) scrapes Ohio county dockets, POSTs events to a Supabase Edge Function, which inserts into `docket_events`, fires email notifications to clients, and feeds every portal's realtime feed.

**Where we are right now**: Castle v2 credentials are set on both sides. The webhook is armed. One smoke test from Castle away from first real events flowing. John Dunn's Butler County case is the first real backfill target (~53 events expected); Kemper Ansel's Franklin case is cued up for a warm client-facing test.

**What's next**: Fire Castle's canned smoke test → verify 12 dummy events hit `docket_events_unmatched` → approve John Dunn backfill → enable daily cron → warm-intro Kemper → ship Phase 3 Library → ship System Health page → credential consolidation in 1Password → daily backup automation.

**Long-term vision**: Compact the entire business into DCC — CRM, Google Drive, QuickBooks, SOPs, AI workspace, multi-brand attribution — so the whole company is one login that transfers cleanly.

---

## 2 — Current Numbers (actual DB snapshot)

| Metric | Count |
|---|---|
| **Deals total** | 21 |
| Deals active (not closed/recovered/dead) | 19 |
| Deals: flips | 5 |
| Deals: surplus | 16 |
| **Leads total** | 1 |
| Leads with status=new | 1 |
| **Contacts (CRM)** | 2 |
| Contact↔Deal links | 7 |
| **Notes (all deals)** | 9 |
| **Activity rows** | 93 |
| **Documents stored** | 43 |
| **Docket events** | 0 (pre-Castle-go-live) |
| **Docket events unmatched** | 0 |
| **Scrape runs** | 0 |
| **Messages** | 0 |
| **Client_access rows** | 2 |
| **Attorney assignments** | 7 (auto-synced from contact_deals) |
| **Auth users total** | 4 |
| Admins | 4 |
| VAs | 0 |
| Attorneys | 0 |
| Clients | 0 |

**Signals**:
- Zero docket events = Castle hasn't fired yet. Expected.
- Attorney assignments (7) = Jeff Kalniz linked to 6 cases via contact_deals + 1 legacy.
- Only 4 auth users = the 4 admin users in profiles. No client or attorney has actually signed into their portal yet.
- 93 activity rows across 21 deals = ~4.4 events per deal. Healthy for a system that's 2 weeks old.

---

## 3 — The Full System Map

### 3.1 Entity + Brand structure

**FundLocators LLC** — Ohio LLC, single legal entity. All operations, all banking, all tax returns.

Three DBAs / brands:

| DBA | Domain | Purpose |
|---|---|---|
| **FundLocators** | fundlocators.com | Primary brand, post-signing ops, SEO, official name on engagement letters |
| **Defender Homeowner Advocates** | defenderha.com | Pre-sale deal activation — work with homeowners *before* auction |
| **RefundLocators** | refundlocators.com | Consumer-facing SMS funnel; DBA registration pending |

Unified phone: **(513) 951-8855** (GHL-unified 2026-04-17). Any doc still showing 513-516-2306 or 513-253-1100 is stale.

### 3.2 Live URLs

| URL | Purpose |
|---|---|
| https://thelocatoroffunds.github.io/deal-command-center/ | DCC (team) |
| https://thelocatoroffunds.github.io/deal-command-center/portal.html | Client portal |
| https://thelocatoroffunds.github.io/deal-command-center/attorney-portal.html | Counsel portal |
| https://thelocatoroffunds.github.io/deal-command-center/lead-intake.html | Public lead form |
| https://rcfaashkfpurkvtmsmeb.supabase.co | Supabase project root |
| https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/docket-webhook | Castle → DCC webhook |

### 3.3 The four portals — who sees what

**DCC (`index.html`)** — team
- Magic-link sign-in → auto-role (admin for known emails, fallback user)
- Today view (urgent + stale + bonuses + unfiled surplus)
- Active/Closed/Flagged/Analytics views with clickable stat cards
- Deal detail: Overview / Messages / Docket / Contacts / Expenses / Tasks / Vendors / Documents / Notes (multi-note list) / Activity
- Leads modal (⌘K), Search modal, Team management, Contacts modal, Docket Center (scraper health + unacknowledged)
- Floating "+ New Deal" button on mobile
- Admin-only fields: all financials, financial UI, expenses tab

**Client portal (`portal.html`)** — homeowner
- Magic-link sign-in → role=client via client_access
- Welcome video (per-deal), payout hero, Surplus Tracker (Domino's-style 5-step), Next Milestone card, Status Intel, Timeline Expectation
- Empathy Check-in (weekly)
- Court activity card (live events + Case History accordion for backfill)
- Notification preferences (email on/off, SMS on/off, phone)
- Messages thread with team
- Documents (upload + view)
- Case details card (case number, filed date, county, status)
- Case team card (attorney, Nathan)
- Sticky Call Nathan button
- Multi-claimant aware (shows count, doesn't leak emails)

**Attorney portal (`attorney-portal.html`)** — counsel
- Magic-link sign-in → role=attorney via attorney_assignments (auto-synced from contact_deals)
- Dashboard: summary strip + case cards with staleness color + docket-7d / docket-unread badges
- Combined cross-case docket feed (backfill excluded)
- Case detail with realtime subscriptions
- Post case update (admin-readable)
- Messages thread with team
- Documents (upload + view)

**Lead intake (`lead-intake.html`)** — public
- No auth. Anon INSERT to `public.leads` with RLS-enforced WITH CHECK
- Full marketing landing page: hero, stat strip, How-It-Works, differentiators, form, founder letter, FAQ, CTA band, footer
- UTM + referrer + landing attribution capture into `leads.metadata`

### 3.4 Backend services

**Supabase project**: `rcfaashkfpurkvtmsmeb`
- Postgres 15 + RLS enforced on every table
- Auth via magic link (email OTP)
- Storage bucket `deal-docs` (all document files, welcome videos, client uploads)
- Realtime publication on all mutable tables
- Edge Functions (Deno)
- Vault for secrets
- pg_cron for schedules
- pg_net for outbound HTTP
- pgvector (newly enabled for Lauren chat, Justin's work)

**External services**:

| Service | Purpose | Key location |
|---|---|---|
| Resend | Outbound email (digest, notifications, magic links) | Vault → `resend_api_key` |
| GHL | SMS + unified phone (513) 951-8855 | Nathan's GHL account — API key NOT yet wired into DCC |
| 2Captcha | CAPTCHA solving for Castle's Butler + Warren counties | Nathan's 2Captcha account — balance funded |
| Castle v2 | Python docket scraper | Runs on Nathan's machine; config/.env holds SUPABASE_SERVICE_KEY + DOCKET_WEBHOOK_SECRET |
| GitHub | Source + auto-deploy via Pages | `TheLocatorOfFunds/deal-command-center` repo |

---

## 4 — Database Schema (authoritative)

All tables in `public` unless noted. RLS enabled on all. Realtime enabled on most.

### 4.1 Core entity tables

| Table | Key columns | Notes |
|---|---|---|
| `profiles` | id (uuid, FK auth.users), name, role | One of: admin, user (legacy admin), va, attorney, client |
| `deals` | id (text PK), type, status, name, address, meta (jsonb), owner_id, lead_source, deadline, filed_at, actual_net, closed_at | meta is flexible grab-bag: county, courtCase, attorney, phone, email, estimatedSurplus, feePct, welcome_video, bonus_due, flagged |
| `expenses` | deal_id, category, amount, date, vendor, notes | Admin-only (RLS blocks VAs) |
| `tasks` | deal_id, title, done, assigned_to, due_date, priority | |
| `vendors` | deal_id, name, role, phone, email, status | Per-deal contractors/contacts (not general CRM) |
| `deal_notes` | id (uuid PK), deal_id, title, body, author_id, created_at, updated_at | Multi-note per deal (Session 21 upgrade) |
| `activity` | deal_id, user_id, action, created_at, visibility text[] | Firehose of every mutation; visibility gates who can read |
| `documents` | deal_id, name, path, size, uploaded_by, extracted, extraction_status | Files in `deal-docs` bucket |

### 4.2 CRM / contact tables (Phase 2)

| Table | Purpose |
|---|---|
| `contacts` | Company-wide CRM: attorneys, title companies, investors, referrers. `kind` column classifies. Financials in `financial_notes` are admin-only. |
| `contact_deals` | Many-to-many: contacts ↔ deals with `role_in_deal` (e.g., "attorney", "referrer"). |

### 4.3 Portal access

| Table | Purpose |
|---|---|
| `client_access` | Links homeowner email → deal. `prefs` jsonb holds notify_email/sms/phone + empathy_checkins. user_id linked on first sign-in. |
| `attorney_assignments` | Links attorney email → deal. AUTO-SYNCED by triggers from contact_deals where contact.kind='attorney'. |

### 4.4 Messaging + leads

| Table | Purpose |
|---|---|
| `messages` | Two-way threads per deal. sender_role ∈ {admin, user, va, client, attorney}. Read receipts via read_by_team_at / read_by_external_at. |
| `leads` | Public intake. Status flow: new → contacted → qualified → signed / rejected / spam / duplicate. metadata.duplicates populated by trigger. |

### 4.5 Docket (Castle integration)

| Table | Purpose |
|---|---|
| `docket_events` | Matched events per deal. Unique on (deal_id, external_id). `is_backfill` boolean — backfill is pre-acknowledged, skips notifications. |
| `docket_events_unmatched` | Events where Castle's case_number+county didn't match any deal. Admin reconciles later via `reconcile_docket_event` RPC. |
| `scrape_runs` | Castle heartbeats: county, counts, status, timestamp. Feeds `scraper_health` view. |

### 4.6 Lauren (AI chat — Justin's work)

| Table | Purpose |
|---|---|
| `lauren_*` tables (pgvector) | Vector embeddings for the refundlocators.com chat widget. Not yet fully wired. |

### 4.7 Views

| View | Purpose |
|---|---|
| `scraper_health` | Per-county snapshot: last_run_started, last_success_at, events_24h, events_7d, failures_24h |

### 4.8 Migration timeline (all 26 applied)

| # | Date | Name | Purpose |
|---|---|---|---|
| 1 | 2026-04-18 | phase1_client_portal_schema | Client portal base |
| 2 | 2026-04-18 | phase1_client_portal_invite_flow | Invite flow |
| 3 | 2026-04-18 | client_access_prefs | prefs jsonb |
| 4 | 2026-04-18 | enable_pg_cron_pg_net | Extensions |
| 5 | 2026-04-18 | send_daily_digest_function | Daily digest via pg_cron |
| 6 | 2026-04-18 | role_system_helpers_and_policies | is_admin/is_va/is_attorney/is_client + RLS |
| 7 | 2026-04-18 | attorney_assignments_and_policies | Attorney portal access |
| 8 | 2026-04-18 | co_claimant_count_function | Multi-claimant privacy |
| 9 | 2026-04-19 | documents_ocr_extraction | OCR pipeline |
| 10 | 2026-04-19 | client_empathy_checkin_function | Weekly mood check-in |
| 11 | 2026-04-19 | attorney_portal_helpers | attorney_post_update, attorney_mark_seen |
| 12 | 2026-04-19 | messages_two_way_thread | Messaging |
| 13 | 2026-04-19 | leads_table_public_intake | Public lead form |
| 14-16 | 2026-04-19 | leads_duplicate_detection_* | Scored dup engine |
| 17 | 2026-04-20 | docket_events_integration | Docket tables |
| 18 | 2026-04-20 | docket_drop_registrations_add_scrape_runs | Simpler Castle model |
| 19 | 2026-04-20 | docket_client_notifications | Email-on-event trigger |
| 20 | 2026-04-20 | create_contacts_and_contact_deals | Phase 2 CRM |
| 21 | 2026-04-20 | message_email_notifications | Message → team email |
| 22 | 2026-04-20 | deal_notes_multi_note | Multi-note refactor |
| 23 | 2026-04-20 | sync_attorney_assignments_from_contacts | Auto-sync triggers |
| 24 | 2026-04-20 | activity_visibility_for_client_attorney_timeline | visibility text[] |
| 25 | 2026-04-21 | docket_events_backfill_awareness | is_backfill column |
| 26 | 2026-04-21 | enable_pgvector_and_create_lauren_tables | Justin: Lauren chat |

---

## 5 — What Shipped This Session (18-22)

### Session 18: Phase 2 CRM — Contacts & Contact-Deals
- New `contacts` + `contact_deals` tables with RLS
- `ContactsModal` + `ContactEditor` components in DCC
- "👥 Contacts" button in header
- `ContactsTab` on deal detail (linked contacts for this case)
- Admin-only financial_notes field on contacts
- Kind-based UX: attorney / title_company / investor / referrer / general

### Session 19: Deal Notes multi-note + Activity visibility
- Refactored `deal_notes` from one-per-deal to many-per-deal (uuid PK, title, author_id)
- Fixed silent save bug (old code was writing to nonexistent content/updated_by columns)
- Added `activity.visibility text[]` column (default `['team']`)
- Rewrote client + attorney RLS to require visibility array membership
- Status changes auto-tagged with `['team','client','attorney']`
- Cleaned up "?" character corruption in historic status rows
- New "📢 Post Update" modal for admins to publish curated client-facing milestones
- logAct signature extended: `logAct(msg, visibility = ['team'])`

### Session 20: Attorney portal dashboard + Contacts→Attorney-assignments sync
- Inbox rebuilt: summary strip, staleness color coding, live badges (docket 7d, docket unread)
- Combined cross-case docket feed card
- 3-trigger sync system between contact_deals and attorney_assignments
- Bridging means: Nathan edits contact relationships in DCC → attorney portal access updates automatically
- Backfilled 7 Jeff Kalniz assignments

### Session 21: Client portal overhaul
- **Surplus Tracker** — 5-step Domino's-style progress bar (Engaged → Filed → Court Review → Approved → Paid), current step pulses gold
- **Next Milestone card** — status-aware "What's next" with date estimates
- 14 stale phone number fixes: 513-516-2306 → 951-8855 across portal.html
- ClientDocketCard split into live events (top) + Case History accordion (backfill, collapsed)
- Status intel rewriting for clearer client-facing language

### Session 22: Castle v2 go-live prep + lead-intake ship
- Redeployed docket-webhook with `verify_jwt=false` (was blocking Castle's non-auth HMAC calls)
- Added `is_backfill` column + RLS + trigger exemption (backfill doesn't spam clients)
- Client portal Case History accordion (collapses is_backfill=true events)
- Attorney portal badge counts exclude backfill
- Generated fresh DOCKET_WEBHOOK_SECRET (old one may have leaked via screenshot/chat)
- Nathan set it on Supabase; I set it in Castle's config/.env
- Found + set SUPABASE_SERVICE_KEY in Castle's .env
- Shipped Justin's lead-intake.html rebuild: fixed 5 phone typos, canonical/OG URL to GitHub Pages, landing attribution dynamic, removed unused useEffect import, email corrected to nathan@fundlocators.com
- Confirmed config/.env is gitignored (zero risk of secret leak via git)

---

## 6 — Immediate Next Steps (the go-live sequence)

This is the critical path. Do these in order.

### Step 1: Castle smoke test (~15 min total)

**You tell Castle**:
> "Secret rotated, service-role key pasted, DCC is Option-B ready. Fire the 12-event canned smoke test: `python -m utils.webhook_client --send-canned --case "SMOKE-TEST-2026" --county Franklin`. Report results."

**Castle runs it, sends 12 events with `external_id` starting with `test-`**. DCC's webhook accepts them, HMAC validates, they land in `docket_events_unmatched` (because case `SMOKE-TEST-2026` doesn't exist in `deals`).

**You report back to me**, or I run:
```sql
select count(*), max(detected_at)
from public.docket_events_unmatched
where case_number = 'SMOKE-TEST-2026';
```
Expected: `12` rows. Then I delete them and we move on.

### Step 2: John Dunn backfill (~30 min)

**You tell Castle**:
> "Smoke test verified. Run John Dunn backfill: `python main.py --step monitor --deal-id surplus-mo03b7l819tp --backfill-days 90`"

Castle produces ~53 historical events, each flagged `backfill: true`, each POSTed to the webhook. DCC inserts with `is_backfill=true` + `acknowledged_at` pre-set. No client emails fire (trigger skips backfill). Events collapse under Case History accordion in the client portal when John eventually signs in.

**I verify**:
```sql
select count(*), min(event_date), max(event_date)
from public.docket_events
where deal_id = 'surplus-mo03b7l819tp' and is_backfill = true;
```

### Step 3: Enable daily cron (~5 min, Castle side)

**You tell Castle**:
> "Backfill verified. Enable daily cron for Franklin + Butler counties. Start with the current 2 deals (Kemper + John); the deals query will auto-pick up anything new we add."

Castle flips its cron on. Every morning at e.g. 6am ET, it scrapes Franklin + Butler dockets for all active DCC deals, sends only *new* events (external_id dedup).

### Step 4: First real event test

Wait for real movement on any of the 19 active deals. When it happens:
- Event arrives at webhook
- HMAC validates
- Deal matches by case_number+county
- `is_backfill=false` → notification trigger fires
- Email to the client_access email for that deal
- Appears live in client portal Court activity card
- Appears in attorney portal if assigned
- Team sees it in DCC Docket tab + activity feed

### Step 5: Kemper warm intro (~10 min)

Once Castle is live and we're confident in the stack:
1. You send Kemper a personal intro email (I can draft) — reference his 2014 foreclosure, the unclaimed surplus sitting at Franklin County per ORC §2329.44, explain what we do, invite him to sign in
2. Kemper visits portal.html, enters `kemper.ansel@gmail.com`, gets magic link
3. Signs in → sees blank-slate portal (empty court activity because nothing has happened yet on his case — we haven't filed the motion to release yet)
4. You file the motion to release at Franklin County
5. Castle's next daily scrape catches the filing → event flows → Kemper gets email + SMS (if GHL wired)
6. Over weeks: hearing scheduled → order → disbursement ordered → celebration hero

### Step 6: Rotate service-role key (~10 min)

After Castle go-live is confirmed working end-to-end (say after 1 week of clean runs):
- Supabase dashboard → Settings → API Keys → rotate service_role
- Update Castle's `config/.env` SUPABASE_SERVICE_KEY=<new value>
- Restart Castle

This is because the current key was pasted in our chat and the risk surface is slightly larger than ideal.

---

## 7 — The Roadmap Forward

### Phase 3: Company-Wide Library (next major build)

Design already locked in `PHASE_3_LIBRARY_PLAN.md`. Answers all 5 open questions. Ships in 3 PRs:

**PR 1** — Tables + RLS
- `library_folders` (hierarchical, owner_role-scoped)
- `library_documents` (metadata + path in `library` storage bucket)
- `library_document_contacts` (attribution: who provided this doc)
- RLS: admin all, va read+create, attorney/client never

**PR 2** — DCC Library tab
- Folder tree sidebar + document list
- Upload, rename, move, tag, version history
- Search across library

**PR 3** — Portal integration
- Client portal can show library docs if `visible_to_client=true`
- Attorney portal same for `visible_to_attorney=true`
- Auto-attach templates to deals (e.g., engagement letter template)

**Replaces**: Google Drive for most FundLocators use cases. Absorbs all the scattered strategy .md files currently in the repo.

### Phase 4: Financial Layer (QuickBooks-alternative)

Not yet designed in detail. Scope:
- `transactions` table (every dollar in/out, linked to deals when applicable)
- `invoices` (generated from deals + manual)
- `commissions` (per-deal splits, referral payouts)
- `monthly_statements` (auto-generated P&L)
- DCC Financial tab (admin-only)
- Tax-ready Schedule C / K export

**Priority**: Ship when monthly reconciliation pain > dev time. Probably after Library ships.

### Phase 5: Knowledge / SOPs / Playbooks

Tables:
- `sops` (operational how-to docs)
- `playbooks` (templates: email, call scripts, legal filings)
- `goals` (OKR-style, time-period-scoped)

Integration: from a deal, one-click "use this playbook" → auto-creates tasks, uses email templates, pulls attorney letter from library.

### Phase 6: AI Workspace

Tables:
- `ideas` (raw capture, status flow)
- `experiments` (hypothesis tests with outcomes)
- `ai_sessions` (log of Claude conversations Nathan ran; knowledge compounds)

"Ask DCC" sidebar calling Anthropic API with RLS-scoped context: *"what's the avg time from signed to recovered in Hamilton County?"*, *"draft a reply to this client message"*, *"summarize last month's leads."*

### Phase 7: Multi-Brand Attribution

- `brands` table: FundLocators / Defender HA / RefundLocators, each with palette, phone, signature, footer, website
- Per-deal brand attribution
- Cross-brand analytics: per-brand revenue, LTV, CAC
- Different portal skins per brand (same backend)

### Phase 8: Ownership-Transfer Layer

- `access_grants`: named login sets with audit trail + revoke
- One-click export: deals CSV, financial summary PDF, doc bundle, SOP archive
- Acquisition-readiness dashboard: case count, pipeline value, monthly revenue run rate, retention, referral sources, tech stack inventory, cap table

**This is the "sell for one login" layer.**

### Smaller backlog items (can slot in anytime)

| Item | Effort | Value |
|---|---|---|
| Post-recovery automation (disbursement_ordered → celebration + Nathan task + commission row) | 2 hrs | High |
| Commission tracking table + UI | 4 hrs | High |
| System Health page (DB row counts, Castle heartbeat, deploy status, storage used) | 4 hrs | High — risk visibility |
| Daily backup pg_cron job + email | 2 hrs | High — peace of mind |
| Email reply parsing (Nathan replies to notification email → DCC picks up as message) | 6 hrs | Medium |
| GHL SMS wiring (once API key provided) | 2 hrs | Medium |
| Attorney notification preferences (opt-in email on docket events) | 2 hrs | Low-medium |
| Duplicate detection in contacts table | 2 hrs | Low |
| External_id format normalization (case-insensitive matching for Castle) | 1 hr | Low |
| test-* filter in production UI queries | 30 min | Low |

---

## 8 — Risk Register & Long-Term Stability

### What's safe today

- **Source code** → GitHub, versioned, Justin has access
- **Production data** → Supabase, auto-backed-up daily (their infra)
- **RLS enforcement** → Postgres-level, can't be bypassed from client-side code
- **Auth** → Supabase managed, magic links, session tokens
- **Documents** → Supabase Storage, replicated

### What's at risk

| Risk | Severity | Mitigation |
|---|---|---|
| **Scattered secrets** (API keys in .env files, Claude Desktop config, keychain, chat history) | High | Consolidate in 1Password, shared with Justin (Step 1 below) |
| **Local-only strategy docs** (JUSTIN_KICKOFF.md, LAUREN_PROMPT_V2.md, REFUNDLOCATORS_VISION.md, etc — all untracked by git) | High | Phase 3 Library absorbs these |
| **Nathan-only institutional knowledge** (why a deal is structured a certain way, who Jeff is, what a "Castle" is) | High | This doc + CLAUDE.md + TRANSFER doc; expand over time |
| **No disaster recovery playbook** (what if Supabase goes down, what if GitHub goes down) | Medium | Daily backup job + Step 4 below |
| **Domain registrar logins** (fundlocators.com, defenderha.com, refundlocators.com) | Medium | Get into 1Password |
| **Financial opacity** (no single source of truth for monthly P&L across brands) | Medium | Phase 4 Financial layer |
| **Justin and Nathan bus factor** (two-person team) | Low-medium | This doc + transfer layer |
| **Castle dependency** (one scraper project) | Low | DCC-side schema is agnostic; any replacement scraper with same webhook contract works |

### Long-term stability plan (5 steps from earlier session)

1. **Credential consolidation** — every API key, password, secret into 1Password. Share vault with Justin. Expected: 1 hour of listing everything + creating vault items.

2. **Daily backup email** — pg_cron job runs a SQL dump of critical tables (deals, activity, messages, documents metadata, contacts, library*), uploads to Supabase Storage, emails Nathan a link. Rolling 30-day retention. Expected: 2 hours to build.

3. **System Health page** — new DCC admin tab showing:
   - GitHub Pages last deploy time + commit hash
   - DB row counts (deals, activity, etc)
   - Castle last heartbeat per county (from scraper_health)
   - Daily digest last success
   - Storage used (bucket breakdown)
   - Any tables exceeding size thresholds
   - Queue depth on notification triggers (if pg_net backlog)
   - Expected: 4 hours to build.

4. **Master Index doc** — short "where is everything" reference:
   - Supabase login + billing
   - GitHub login + billing
   - Resend login + billing + sender DNS
   - GHL login + billing
   - 2Captcha login + billing
   - Domain registrar(s) + DNS records
   - Anthropic API key location + billing
   - Where every secret lives
   - Expected: 30 min to draft.

5. **Phase 3 Library** — absorb scattered local docs into DCC so nothing lives only on Nathan's laptop. Covered above.

**None of these block current operations.** They're resilience and sellability. Do them when the immediate go-live sequence clears.

---

## 9 — Credential Map

Where every secret lives today (nothing commits to git; this is a pointer map, not values).

| Secret | Location | Used by |
|---|---|---|
| Supabase anon (publishable) key | Hardcoded in HTML files | Public — RLS protects |
| Supabase service_role key | 1. Supabase dashboard Settings → API Keys → JWT Keys<br>2. `~/Documents/Claude/refundlocators-pipeline/config/.env` as `SUPABASE_SERVICE_KEY` | Castle's writes |
| DOCKET_WEBHOOK_SECRET | 1. Supabase Edge Function secrets (masked in UI)<br>2. Castle's `config/.env` as `DOCKET_WEBHOOK_SECRET` | HMAC validation in docket-webhook |
| ANTHROPIC_API_KEY | Supabase Edge Function secrets | `extract-document` OCR + future AI uses |
| resend_api_key | Supabase Vault | pg_net sends from daily digest + notifications |
| GHL API key + location ID | Nathan's GHL account — **not yet pulled into DCC** | Future SMS |
| 2Captcha API key | Nathan's 2Captcha account — **not yet shared with Castle** | Castle CAPTCHA solving |
| GitHub PAT | Nathan's macOS keychain | Git push |
| Supabase MCP access token | `~/Library/Application Support/Claude/claude_desktop_config.json` | Claude Desktop tool calls |

**Never put in git**: service_role, DOCKET_WEBHOOK_SECRET, ANTHROPIC_API_KEY, GHL key, 2Captcha key, GitHub PAT. The anon key is the only public one.

---

## 10 — Operational Playbook

### Daily rhythm (after go-live)

**Morning (8am ET)**: Daily digest email lands in Nathan's inbox. Scan for urgents.
**Mid-morning**: DCC Today view → handle urgent + stale list.
**When a client messages**: email notification arrives → reply via DCC (or future: reply-by-email).
**When a docket event fires**: DCC Docket badge lights up → acknowledge or act.
**When 2Captcha balance drops**: 2Captcha emails a warning → top up.

### When something breaks

**Webhook not accepting events**:
1. Check Supabase Edge Function logs for docket-webhook
2. Verify DOCKET_WEBHOOK_SECRET still matches between Supabase + Castle
3. If mismatched, rotate (generate new, set both sides)

**Notifications not sending**:
1. Check `net._http_response` for recent rows — are they 2xx or 5xx?
2. If 5xx from Resend: check Resend dashboard, check quota
3. Check activity table — did the trigger fire?
4. Check `vault.decrypted_secrets` — is `resend_api_key` still there?

**GitHub Pages not updating**:
1. Check https://github.com/TheLocatorOfFunds/deal-command-center/actions — any failing builds?
2. Force rebuild: make a trivial commit (edit README, push)
3. Browser cache? Try `?v=<timestamp>` on the URL

**Castle scraper failing for a county**:
1. Check `scrape_runs` for that county — what error?
2. If CAPTCHA-related: verify 2Captcha balance
3. If rate-limit: back off + retry
4. If site change: Castle code update needed

### When you want to build something new

1. Tell Nathan's Claude Code session in plain English: "Add X. Here's why. Here's where it goes."
2. Claude reads CLAUDE.md + TRANSFER doc + this doc to ground itself
3. Claude proposes a migration + code change
4. Nathan approves direction
5. Claude applies migration via MCP
6. Claude edits the HTML file
7. Claude commits + pushes
8. Wait 30-60s for Pages rebuild
9. Verify in browser
10. Iterate if needed

### When you want to hand off to a new person

1. Point them at this doc first
2. Then CLAUDE.md
3. Then TRANSFER_TO_NEW_CLAUDE_CODE.md
4. Then the domain-specific docs (CASTLE_DOCKET_INTEGRATION, PHASE_3_LIBRARY_PLAN, REFUNDLOCATORS_VISION)
5. Give them Supabase dashboard read access (Supabase → Authentication → Users → invite)
6. Give them GitHub repo collaborator access
7. Share 1Password vault once credentials are consolidated
8. Have them sign in to DCC once — profile auto-creates — then set their role in SQL

---

## 11 — Key Technical Patterns (subtle but important)

### Activity visibility

`activity.visibility text[]` controls what each role can see in timelines. Default `['team']` means admin/VA only. Status changes get `['team','client','attorney']`. Explicitly-published milestones via the "📢 Post Update" modal get `['team','client','attorney']`. Internal events (bonuses, assignments, doc uploads) stay `['team']`.

The RLS policy on activity reads:
- Admin → everything
- VA → everything
- Attorney → rows where deal is in their assignments AND ('attorney' = any(visibility))
- Client → rows where deal is in their client_access AND ('client' = any(visibility))

This means the same firehose `activity` table drives every portal's timeline, but each portal shows a curated slice. No duplication, no separate "client_activity" table.

### Backfill awareness

`docket_events.is_backfill boolean` distinguishes Castle's historical replay from live events.

When Castle runs `--backfill-days 90` on a case, each event gets `backfill: true` in the webhook payload. The Edge Function:
1. Inserts with `is_backfill = true`
2. Pre-sets `acknowledged_at = now()` (already considered "read")

The trigger `dispatch_docket_client_notifications`:
1. Skips rows where `is_backfill = true` (no email spam on a 53-event replay)

The client portal:
1. Queries live events: `where is_backfill = false`, renders prominently
2. Queries history: `where is_backfill = true`, collapses into "📜 Case history · N entries" accordion

The attorney portal badge counts:
1. `.filter(ev => !ev.is_backfill)` everywhere

Net effect: a case with 53 years of history and 2 new events shows 2 badges, not 55, and no client gets a 53-email firehose.

### Contacts → Attorney Assignments sync

Contacts is the authoritative source Nathan edits. `attorney_assignments` is what the attorney portal RLS reads. 3 triggers keep them in lockstep:

1. On `contact_deals` INSERT where contact.kind='attorney' → create attorney_assignments row
2. On `contact_deals` DELETE → disable attorney_assignments
3. On `contacts` UPDATE changing kind → create/disable attorney_assignments accordingly

Nathan never touches attorney_assignments directly. Single-source-of-truth = contacts.

### Test event safety filter

Any docket_event with `external_id` starting with `test-` or `mock-` is filtered out of:
- Notification dispatch trigger (no emails)
- Client portal queries (not shown)
- Attorney portal counts (excluded)

This means Castle can fire test events against the live webhook safely; they land in `docket_events_unmatched` but never reach real clients.

### Notification fan-out

Two directions in `messages` trigger:

**Client/attorney → team**: Email `nathan@fundlocators.com` (hardcoded; future: `team_notification_prefs` table) with case context + "Reply in DCC" CTA. `reply_to: nathan@fundlocators.com` so replying in mail client goes to Nathan.

**Team (admin/va/user) → client**: Email every enabled `client_access.email` for the deal where `prefs.notify_email != false`. CTA to "Open your case portal."

Both directions log an activity row so team sees delivery trail.

Docket notifications work the same way but:
- Only fire for client-facing event_types (disbursement_*, hearing_*, judgment_entered)
- Skip backfill
- Skip test/mock external_ids
- Optional SMS stub (logs placeholder until GHL is wired)

---

## 12 — Brand & Voice Reference

### Palette (authoritative)

```
--navy:       #0b1f3a  (primary brand, nav, CTAs)
--navy-mid:   #17355e  (hover states, gradients)
--gold:       #c9a24a  (accent, brand dot, CTA)
--gold-light: #d8b560  (accent hover)
--gold-soft:  #ede5cf  (soft gold backgrounds)
--cream:      #fffcf5  (cream text on navy)
--bg:         #fbf8f1  (page bg, client portal)
--bg-card:    #ffffff  (card bg, light theme)
--text:       #1a1a1a
--text-muted: #6b6b6b
--green:      #2d7a4f  (success, recovered)
--red:        #a83232  (error, objection, alert)
```

DCC uses **dark theme** (`#0c0a09`, `#1c1917` base). Portals use **cream/light theme**.

**No red, no bright green, no all-black** per brand non-negotiables.

### Typography

- Display / headings: **Fraunces** (serif)
- Body: **Inter** (sans)
- Monospace (numbers, timestamps): **DM Mono**

### Voice

- Warm, knowledgeable, approachable
- "Smart friend who knows the system"
- Never: call-center, government, scammy, salesy
- Core refundlocators line: *"We already know your case. Let us show you what we found."*

### Phone (single source of truth)

- **(513) 951-8855** (GHL unified)
- Legacy numbers in older docs: 513-516-2306, 513-253-1100 — update when seen

---

## 13 — How to Brief a New Claude Code Session

Copy-paste this as your first message to a fresh Claude Code in the FundLocators project:

> Read these three files in order:
> 1. `PROJECT_STATUS_AND_ROADMAP.md` (this is the current state)
> 2. `CLAUDE.md` (technical primer + gotchas)
> 3. `TRANSFER_TO_NEW_CLAUDE_CODE.md` (business handoff — supplements roadmap)
>
> Then verify you can:
> - See ~26 migrations via the Supabase MCP
> - See ~21 deals via list_tables
> - `git pull` from `TheLocatorOfFunds/deal-command-center`
>
> Report back: "Context loaded. Current phase: [what you understand we're on]. What's top of mind today?"

### Key principles the new session must know

1. **Nathan is a non-coder / prompter.** Explain in business terms first, technical second. Don't lead with code blocks.
2. **Bias toward doing over asking.** Small changes, just ship. Big ones, confirm direction first.
3. **Respect brand boundaries.** DCC vs. refundlocators.com vs. defenderha.com have separate scopes and separate Claude Code sessions. If work crosses boundaries, stop and surface.
4. **Honesty above all.** Don't fabricate data (see Session 13 lesson — I made up docket events once; never again). When uncertain, say so.
5. **Financial UI gating is a hard rule.** VAs must never see dollar amounts. Trust RLS; don't expose in UI.
6. **Mobile matters.** Most users work from phones.
7. **Default to commit.** Nathan can always revert. Delayed ships cost more than bad commits.

---

## 14 — Quick Reference Index

### Dashboards
- Supabase: https://supabase.com/dashboard/project/rcfaashkfpurkvtmsmeb
- GitHub: https://github.com/TheLocatorOfFunds/deal-command-center
- Resend: https://resend.com (Nathan's login)
- GHL: (Nathan's login)
- 2Captcha: https://2captcha.com (Nathan's login)

### Key repo paths
- Root: `/Users/alexanderthegreat/Documents/Claude/deal-command-center/`
- Castle: `/Users/alexanderthegreat/Documents/Claude/refundlocators-pipeline/`

### Critical files
- `index.html` — DCC
- `portal.html` — Client portal
- `attorney-portal.html` — Counsel portal
- `lead-intake.html` — Public form
- `supabase/functions/docket-webhook/index.ts` — Webhook source
- `CLAUDE.md`, this doc, `TRANSFER_TO_NEW_CLAUDE_CODE.md`, `CASTLE_DOCKET_INTEGRATION.md`, `PHASE_3_LIBRARY_PLAN.md`

### Commands cheatsheet
```bash
# Pull latest
cd ~/Documents/Claude/deal-command-center && git pull

# Open an app
open index.html

# Push (after commit)
git push origin main

# Wait for Pages rebuild
# ~30-60s, then hard-refresh the live URL with ?v=<timestamp>

# Check Castle
cd ~/Documents/Claude/refundlocators-pipeline && cat config/.env | grep DOCKET
```

### Role-check cheatsheet
```sql
select id, name, role from public.profiles;
-- admin/user = full
-- va        = no financials
-- attorney  = scoped to attorney_assignments
-- client    = scoped to client_access
```

---

## 15 — Closing Principle

Every decision in this system — every UI choice, every trigger, every notification cadence, every table shape — is weighed against one question:

> *Does this make recovering the client's money faster, clearer, less scary, or more honest?*

If yes, ship.
If no, don't.

If you're unsure, ask.

That's the business. That's the product. That's the filter.

— End of doc. Update the "Point-in-time" date at the top whenever the world changes meaningfully.
