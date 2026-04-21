# Command Center — Merge Brief for the Partner's Claude Code

**From**: Nathan's Claude Code session (DCC + portals + Castle integration side)
**To**: Justin's Claude Code session (the partner's parallel build)
**Purpose**: So we can merge both sides of the work into one unified CRM / operating brain for the business — code, data, docs, thoughts, ideas, everything — with zero duplication and full RLS integrity.

**Date of snapshot**: Apr 21, 2026
**Companion files in this repo that Justin's Claude should read first**:
- `PROJECT_STATUS_AND_ROADMAP.md` — full point-in-time status
- `TRANSFER_TO_NEW_CLAUDE_CODE.md` — full business + technical transfer doc
- `CLAUDE.md` — AI collaborator primer (the short version)
- `CASTLE_DOCKET_INTEGRATION.md` — docket scraper contract
- `PHASE_3_LIBRARY_PLAN.md` — the Google-Drive-replacement design
- `ROADMAP.md` — original product roadmap

**Read those three first (ROADMAP, CLAUDE.md, PROJECT_STATUS_AND_ROADMAP). Come back here for the merge-specific guidance.**

---

## 1 — The premise, in plain English

Nathan and Justin have been prompting two parallel Claude Code sessions on the same Supabase project (`rcfaashkfpurkvtmsmeb`). Both writing code. Both applying migrations. Both pushing to `github.com/TheLocatorOfFunds/deal-command-center`. This has worked — but it's now worth merging the two mental models into one so we don't:

- Create duplicate tables
- Fight over RLS policy definitions
- Ship conflicting email templates
- Duplicate Edge Functions
- Build two versions of the same feature (Lauren on Justin's side vs AI workspace on Nathan's side, for example)

**End state Nathan described**: *"one amazing CRM, all-encompassing brain for our business and lives — code, thoughts, ideas, features, documents, processes, SOPs, financials."* One login, everything in it, sellable as a business.

This document is the consolidated description of what Nathan's side has put into the shared Supabase + repo so Justin's Claude can diff against it.

---

## 2 — Stack we both write into

| Layer | What |
|---|---|
| Backend DB | Supabase Postgres, project ref `rcfaashkfpurkvtmsmeb` |
| Auth | Supabase Auth, magic-link (OTP) |
| Storage | `deal-docs` bucket |
| Edge Functions | Deno, deployed via MCP or CLI |
| Realtime | `supabase_realtime` publication (add tables to it as needed) |
| Secrets | `vault.decrypted_secrets` for in-DB use, Edge Function env vars for JS use |
| Cron | `pg_cron` extension |
| Outbound HTTP | `pg_net` extension |
| Vector embeddings | `pgvector` (just enabled — for Lauren pipeline) |
| Hosting | GitHub Pages on `main` branch, `deal-command-center` repo, auto-deploys in ~30-60s |
| Custom domain | `app.refundlocators.com` (as of Apr 21, 2026 — SSL provisioning) |
| Email | Resend, sender `hello@refundlocators.com` — API key in Vault |
| SMS | GHL — **NOT yet wired into DCC**. API key pending. |
| Docket scraping | Castle v2 Python project — separate repo, writes to DCC's DB |

**Rule of thumb**: if Justin's side adds anything, it goes into this Supabase project (not a separate one), into a repo we both push to, under the same stack conventions below.

---

## 3 — Applied migrations (26 as of this writing)

Every migration Nathan's side has run. If Justin's side has any of these, they're no-op-duplicates — can be dropped from Justin's local migration queue. If Justin has applied any that aren't in this list, those are new — we need to review and incorporate.

| # | Date | Name | One-line purpose |
|---|---|---|---|
| 1 | 2026-04-18 | `phase1_client_portal_schema` | Client portal base |
| 2 | 2026-04-18 | `phase1_client_portal_invite_flow` | Invite flow tables |
| 3 | 2026-04-18 | `client_access_prefs` | `prefs` jsonb column |
| 4 | 2026-04-18 | `enable_pg_cron_pg_net` | Extensions |
| 5 | 2026-04-18 | `send_daily_digest_function` | Daily digest email cron |
| 6 | 2026-04-18 | `role_system_helpers_and_policies` | `is_admin / is_va / is_attorney / is_client` + RLS |
| 7 | 2026-04-18 | `attorney_assignments_and_policies` | Counsel portal access |
| 8 | 2026-04-18 | `co_claimant_count_function` | Multi-claimant privacy |
| 9 | 2026-04-19 | `documents_ocr_extraction` | OCR pipeline fields |
| 10 | 2026-04-19 | `client_empathy_checkin_function` | Weekly mood check-in |
| 11 | 2026-04-19 | `attorney_portal_helpers` | `attorney_post_update`, `attorney_mark_seen` |
| 12 | 2026-04-19 | `messages_two_way_thread` | Messaging |
| 13 | 2026-04-19 | `leads_table_public_intake` | Public lead form support |
| 14-16 | 2026-04-19 | `leads_duplicate_detection_*` | Scored dup engine |
| 17 | 2026-04-20 | `docket_events_integration` | Docket tables |
| 18 | 2026-04-20 | `docket_drop_registrations_add_scrape_runs` | Simpler Castle model |
| 19 | 2026-04-20 | `docket_client_notifications` | Email-on-event trigger |
| 20 | 2026-04-20 | `create_contacts_and_contact_deals` | Phase 2 CRM |
| 21 | 2026-04-20 | `message_email_notifications` | Message → team email |
| 22 | 2026-04-20 | `deal_notes_multi_note` | Multi-note refactor |
| 23 | 2026-04-20 | `sync_attorney_assignments_from_contacts` | Auto-sync triggers |
| 24 | 2026-04-20 | `activity_visibility_for_client_attorney_timeline` | `visibility text[]` |
| 25 | 2026-04-21 | `docket_events_backfill_awareness` | `is_backfill` column |
| 26 | 2026-04-21 | `enable_pgvector_and_create_lauren_tables` | **Justin's work — already in DB** |
| 27 | 2026-04-21 | `rebrand_fundlocators_to_refundlocators_in_triggers` | Email template rebrand |

**If Justin's Claude has local-only migrations not in this list, they need to be reconciled.** Run `list_migrations` via MCP to verify.

---

## 4 — Tables in `public` schema (authoritative)

All have RLS enabled. All have appropriate policies for the 4-tier role model.

### 4.1 Core entity tables (the deal pipeline)

| Table | What it holds | Row count (Apr 21) |
|---|---|---|
| `profiles` | 1:1 with `auth.users`, holds `role` | 4 |
| `deals` | The core entity (flip/surplus/wholesale/rental/other). `id` is text PK. Flexible `meta` jsonb. | 21 |
| `expenses` | Per-deal line items. **Admin-only via RLS.** | varies |
| `tasks` | Per-deal todos | varies |
| `vendors` | Per-deal contractors/contacts (deal-scoped, different from `contacts`) | varies |
| `deal_notes` | Per-deal notes — **MANY per deal** (refactored Apr 20 from 1-per-deal). UUID PK. | 9 |
| `activity` | Audit log + team/client/attorney timeline feed. **`visibility text[]` column controls who can read each row.** | 93 |
| `documents` | Per-deal file metadata. Files in `deal-docs` storage bucket. OCR via `extract-document` Edge Function. | 43 |

### 4.2 Portal access (RLS scoping tables)

| Table | What it holds |
|---|---|
| `client_access` | Links homeowner email → deal. `prefs` jsonb holds `notify_email`, `notify_sms`, `notify_phone`, empathy-checkin history. `user_id` linked on first sign-in. |
| `attorney_assignments` | Links attorney email → deal. **AUTO-SYNCED** by 3 triggers from `contact_deals` where contact.kind='attorney'. Do NOT insert here directly — edit `contacts` instead. |

### 4.3 Messaging + leads

| Table | What it holds |
|---|---|
| `messages` | Two-way threads per deal. `sender_role` ∈ {admin, user, va, client, attorney}. Has `read_by_team_at` / `read_by_external_at`. Plus `direction` column (Justin's recent add) for inbound/outbound SMS. |
| `leads` | Public intake form submissions (anon INSERT allowed with WITH CHECK). Status flow: `new → contacted → qualified → signed / rejected / spam / duplicate`. `metadata` jsonb auto-populated with dup-detection results + UTM + referrer. |

### 4.4 CRM / Contacts (Phase 2)

| Table | What it holds |
|---|---|
| `contacts` | Company-wide CRM: attorneys, title companies, investors, referrers, partners, press, competitors. `kind` column classifies. `financial_notes` column is admin-only (trust-based UI hide). |
| `contact_deals` | Many-to-many between contacts and deals. `role_in_deal` (e.g., "attorney", "referrer", "title"). Unique on (contact_id, deal_id). |

### 4.5 Docket (Castle integration)

| Table | What it holds |
|---|---|
| `docket_events` | Matched events per deal. Unique on (deal_id, external_id). **`is_backfill boolean`** distinguishes historical replays (pre-acknowledged, skip notifications) from live events. |
| `docket_events_unmatched` | Events Castle sent before a matching deal existed. Admin reconciles via `reconcile_docket_event` RPC. |
| `scrape_runs` | Castle heartbeats — one row per county per monitor run. Feeds `scraper_health` view. |

### 4.6 Lauren AI chat (Justin's pgvector work)

Justin's Claude knows these better than I do. From what I see in the DB (migration 26):

- `lauren_*` tables for vector embeddings
- Used by the refundlocators.com chat widget
- Not yet fully wired into DCC portals

**This is a clear merge surface** — Justin's Claude should describe these back to me so we document them centrally.

### 4.7 SMS (Justin's recent additions)

- `supabase/functions/send-sms/index.ts` — outbound SMS Edge Function
- `supabase/functions/receive-sms/index.ts` — inbound SMS Edge Function
- `messages.direction` column — inbound vs outbound

Justin's Claude is closer to these. Should document more.

---

## 5 — Functions / triggers / RPCs (authoritative list)

### Helpers (SECURITY DEFINER, bypass profile RLS)

- `public.is_admin()` — role = 'admin' OR 'user' (legacy)
- `public.is_va()` — role = 'va'
- `public.is_attorney()` — role = 'attorney'
- `public.is_client()` — role = 'client'
- `public.my_case_claimant_count()` — privacy-safe co-claimant count for client portal

### Business RPCs

- `public.client_empathy_checkin(mood, response)` — weekly client emotional check-in (rate-limited to 7 days)
- `public.attorney_post_update(deal_id, note)` — attorney writes to activity feed
- `public.attorney_mark_seen()` — timestamp on attorney_assignments
- `public.send_daily_digest()` — builds + emails daily digest (cron-scheduled at 12:00 UTC)
- `public.find_lead_duplicates(...)` — scored dup-match engine across leads + deals
- `public.dismiss_lead_duplicates(id, note)` — mark dup warning reviewed
- `public.rescan_lead_duplicates(id)` — rerun detection after editing a lead
- `public.acknowledge_docket_event(id)` — team marks event reviewed
- `public.reconcile_docket_event(unmatched_id, deal_id)` — link staged event to deal
- `public.docket_unacknowledged_count()` — for the nav badge
- `public.update_client_notify_prefs(email_flag, sms_flag, phone)` — client updates own notification prefs

### Triggers (automations that fire on table events)

- `handle_new_user` — on `auth.users` insert, assigns role (client if pending invite, attorney if pending assignment, else admin)
- `leads_flag_duplicates` — before insert on `leads`, populates `metadata.duplicates` + `metadata.duplicate_count`
- `docket_events_client_notify` (`dispatch_docket_client_notifications`) — after insert on `docket_events`, emails client via Resend for client-facing event types (skips backfill + test/mock/canned external_ids)
- `messages_email_notify` (`dispatch_message_notifications`) — after insert on `messages`, emails Nathan for inbound, client for outbound
- `tg_sync_attorney_assignments_from_contact_deal` + 2 related — keep attorney_assignments in sync with contact_deals
- `touch_updated_at` on several tables — sets `updated_at = now()` on UPDATE

### Views

- `public.scraper_health` — per-county scraper dashboard snapshot

### Edge Functions

- `extract-document` — Claude Vision OCR on uploaded PDFs/images
- `docket-webhook` — receives HMAC-signed events from Castle, inserts into docket_events (or unmatched staging)
- `send-sms` — Justin's outbound SMS (GHL/Twilio target)
- `receive-sms` — Justin's inbound SMS webhook

---

## 6 — The 4 HTML apps

All live at `app.refundlocators.com` once DNS + GitHub Pages SSL finalizes. Fallback `thelocatoroffunds.github.io/deal-command-center/`.

| File | Audience | What it does |
|---|---|---|
| `index.html` | Team (admin + VA) | Deal Command Center — pipeline tracking, deal detail, CRM contacts, docket center, leads, team management, search, admin preview of client/counsel portals |
| `portal.html` | Client (homeowner) | Case portal — status, welcome video, Surplus Tracker (Domino's-style 5-step), Next Milestone, Court Activity (live events + Case History accordion), empathy check-in, messages, documents, notification prefs |
| `attorney-portal.html` | Counsel | Inbox with staleness coloring + docket badges, case detail, docket feed, update posting, messages, documents |
| `lead-intake.html` | Public | Full marketing landing page — hero, stat strip, How-It-Works, differentiators, form, founder letter, FAQ, CTA band, footer. UTM + referrer attribution captured. |

---

## 7 — Conventions Justin's side MUST follow for the merge to be clean

### Naming

- **Tables**: `snake_case`, plural, in `public` schema. E.g., `docket_events`, not `DocketEvent`.
- **Columns**: `snake_case`. E.g., `created_at`, not `createdAt`.
- **RPCs**: `snake_case`, verb-noun. E.g., `dismiss_lead_duplicates`.
- **`meta` jsonb keys inside tables**: `camelCase` (legacy convention — e.g., `courtCase`, `estimatedSurplus`). Don't introduce snake_case in meta or we'll fight.
- **Migrations**: descriptive snake_case, Apr-2026-style: `docket_events_backfill_awareness` not `v2_docket_update`.
- **Edge Functions**: kebab-case. E.g., `docket-webhook`, `send-sms`.

### RLS (hard rules)

1. **Every public table has RLS enabled**. No exceptions.
2. **4-tier role model**: admin, va, attorney, client (the lowercase `user` still exists as a legacy admin alias).
3. **Use the helpers**: `public.is_admin()` etc. — don't inline `EXISTS (SELECT FROM profiles...)`.
4. **Admin policies are named `admin_all_<table>`**.
5. **VA policies named `va_<verb>_<table>`** (usually `va_read_*`, sometimes `va_write_*`).
6. **Attorney/client policies scope by their respective link tables** (`attorney_assignments`, `client_access`).

### Activity visibility

`activity.visibility text[]` column default `['team']` controls who can read each row in client/attorney timelines. Pattern:

```sql
-- Internal event, team-only:
INSERT INTO activity (deal_id, user_id, action, visibility)
VALUES ($1, $2, 'Bonus marked due', ARRAY['team']);

-- Client-facing milestone:
INSERT INTO activity (deal_id, user_id, action, visibility)
VALUES ($1, $2, 'Case moved to filed', ARRAY['team','client','attorney']);
```

If Justin's code writes to `activity` without the visibility array, it defaults to team-only. That's safe. But if Justin WANTS clients to see something, set `visibility` explicitly.

### Test-event filter

Any `external_id` starting with `test-` / `mock-` / `canned-` is filtered out of:
- Notification dispatch triggers (no emails)
- Client portal queries (not shown)
- Attorney portal counts (excluded)

Any new notification-firing trigger MUST respect this filter. Pattern:

```sql
IF NEW.external_id LIKE 'test-%'
   OR NEW.external_id LIKE 'mock-%'
   OR NEW.external_id LIKE 'canned-%' THEN
  RETURN NEW;
END IF;
```

### Backfill-awareness

`docket_events.is_backfill` — TRUE means historical replay. Skip notifications. Collapse under Case History accordion.

### Brand in email templates

**All email templates say "RefundLocators"**, NOT "FundLocators". The `FundLocators LLC` legal entity name is only used in legal footers, NEVER in brand-facing copy, subject lines, or eyebrow text. Sender name: `RefundLocators <hello@refundlocators.com>`.

Recent migration (`rebrand_fundlocators_to_refundlocators_in_triggers`) cleaned the 3 existing email-sending triggers. Any NEW email trigger Justin's side adds must follow the same brand.

### Realtime

If you add a table that DCC or a portal should subscribe to live, add it to the publication:
```sql
ALTER PUBLICATION supabase_realtime ADD TABLE public.your_table;
```

---

## 8 — Credentials and secrets (shared via out-of-band channels)

Nothing here is committed to git. This is a map of where they LIVE.

| Secret | Location | Used by |
|---|---|---|
| Supabase anon (publishable) key | Hardcoded in all 4 HTML files | Public — RLS protects data |
| Supabase service_role key | Castle's `config/.env`, Supabase dashboard | Castle writes, Edge Functions |
| `DOCKET_WEBHOOK_SECRET` | Supabase Edge Function secrets + Castle's `config/.env` | HMAC validation of docket events |
| `resend_api_key` | Supabase Vault (`vault.decrypted_secrets`) | pg_net sends from triggers + daily digest |
| `ANTHROPIC_API_KEY` | Supabase Edge Function secrets | `extract-document` OCR |
| GHL API key + location ID | Nathan's GHL account — **NOT yet wired** | Future SMS via DCC |
| Twilio creds | Justin may have — **verify with his Claude** | SMS send/receive |
| 2Captcha API key | Nathan's 2Captcha account | Castle Butler/Warren calibration |
| GitHub PAT | macOS keychain (local) | `git push` |

**Merge rule**: if Justin's side has stored a credential in a 3rd location I don't know about, document it here and we pick ONE location as canonical (preferably Supabase Vault for DB-side, Edge Function secrets for function-side, 1Password for human-readable).

---

## 9 — What's done end-to-end on Nathan's side (what Justin's Claude should NOT rebuild)

### DCC (team app)
- [x] Magic-link auth, role auto-assignment
- [x] Deal pipeline (flip + surplus, multiple statuses per type)
- [x] Deal detail with 9 tabs (Overview, Messages, Docket, Contacts, Expenses, Tasks, Vendors, Documents, Notes (multi-note), Activity)
- [x] Today view with urgent/stale/bonuses/unfiled surplus priority queues + clickable stat cards
- [x] Active / Closed / Flagged / Analytics views
- [x] Leads modal with ⌘K search
- [x] Lead intake form (public)
- [x] Duplicate lead detection (scored match, auto-flag, dismiss/rescan)
- [x] Contacts modal + Contacts tab on deal detail
- [x] Team management modal (invite, role set)
- [x] Docket Center (cross-deal unacknowledged list + scraper health)
- [x] Admin preview of client + counsel portals (no fake accounts needed)
- [x] Post Update modal (curated client-facing activity entries)
- [x] Deal-detail floating action button on mobile
- [x] Mobile-first polish: safe-area insets, 16px inputs (iOS no-zoom), bottom-sheet modals, 38-44px tap targets

### Client portal
- [x] Magic-link auth via client_access
- [x] Status chip, welcome video, payout hero
- [x] Surplus Tracker (Domino's-style 5-step pulsing)
- [x] Next Milestone card (status-aware)
- [x] Status Intel + Timeline Expectation
- [x] Court Activity card with live events + Case History accordion (backfill-aware)
- [x] Empathy check-in (weekly, rate-limited)
- [x] Messages thread with team (two-way via messages table)
- [x] Documents (upload + view with OCR)
- [x] Case details card + Case team card
- [x] Sticky Call Nathan button (mobile)
- [x] Notification preferences (email on/off, SMS stub on/off, phone)
- [x] Multi-claimant aware (doesn't leak other claimants' emails)

### Counsel portal
- [x] Magic-link auth via attorney_assignments (auto-synced from contact_deals)
- [x] Inbox with summary strip + staleness color coding + docket-7d + docket-unread badges
- [x] Combined cross-case docket feed (backfill excluded)
- [x] Case detail with realtime
- [x] Post Update form → activity feed
- [x] Messages thread with team
- [x] Documents (upload + view)

### Docket / Castle integration
- [x] Edge Function `docket-webhook` with HMAC SHA-256 validation, verify_jwt=false
- [x] `docket_events` + `docket_events_unmatched` + `scrape_runs` tables
- [x] `scraper_health` view
- [x] `is_backfill` column + trigger-level exemption
- [x] Acknowledge + Reconcile RPCs
- [x] Notification fan-out on client-facing event types
- [x] Test-event filter (`test-` / `mock-` / `canned-` prefix skip)
- [x] Castle's `config/.env` has all 4 required variables
- [ ] Smoke test + John Dunn backfill + daily cron — **blocked on Castle**

### Email / notifications
- [x] Daily digest (pg_cron at 12:00 UTC, Resend)
- [x] Docket event → client email
- [x] Message → team/client email (both directions)
- [x] Brand: all templates rebranded to RefundLocators
- [ ] SMS wiring — awaiting GHL API key OR Twilio creds (Justin may have progress here)

### Domain / infrastructure
- [x] Custom domain `app.refundlocators.com` (Cloudflare CNAME → GitHub Pages)
- [x] SSL via Let's Encrypt (provisioning — expected within 30 min of this doc)
- [x] Lead intake form canonical URL updated
- [ ] Email templates URL swap to `app.refundlocators.com` — **pending SSL green**

### Documentation (the ever-growing Library)
- [x] `CLAUDE.md` — primer
- [x] `PROJECT_STATUS_AND_ROADMAP.md` — status
- [x] `TRANSFER_TO_NEW_CLAUDE_CODE.md` — business transfer
- [x] `CASTLE_DOCKET_INTEGRATION.md` — Castle contract
- [x] `CASTLE_JOHN_DUNN_PROMPT.md` — specific test case brief
- [x] `PHASE_3_LIBRARY_PLAN.md` — company-wide library design
- [x] `README.md`, `ROADMAP.md`, `ONBOARDING.md` — baseline
- [ ] Several strategy docs gitignored (brand-boundary separation — live locally only)

---

## 10 — What's on the roadmap (the merge targets)

### Immediate go-live (this week)
- [ ] Castle smoke test → John Dunn backfill → daily cron
- [ ] Kemper warm intro (Nathan sends) + first real event through full pipeline
- [ ] Email template URL swap to `app.refundlocators.com`
- [ ] Rotate service-role key post-go-live

### Phase 3: Company-Wide Library (designed, ready to build)
3 PRs outlined in `PHASE_3_LIBRARY_PLAN.md`:
1. Tables + RLS (`library_folders`, `library_documents`, `library_document_contacts`)
2. DCC Library tab (folder tree, docs, versions)
3. Portal integration (client/attorney see selected docs)

**Replaces Google Drive for SOPs, templates, brand assets, training videos.**

### Phase 4: Financial layer (designed in rough form)
- `transactions`, `invoices`, `commissions`, `monthly_statements` tables
- DCC Financial tab (admin-only)
- Schedule C / K export
- Per-deal true-up

**Replaces QuickBooks for the operational core.**

### Phase 5: Knowledge / SOPs / Playbooks
- `sops`, `playbooks`, `goals` tables
- One-click "use this playbook" from a deal → auto-creates tasks + uses email templates
- OKR-style goal tracking

### Phase 6: AI Workspace
- `ideas`, `experiments`, `ai_sessions` tables
- "Ask DCC" sidebar calling Anthropic API with RLS-scoped context
- Lauren chat (pgvector — Justin has base) integrated into DCC as internal assistant too
- Knowledge compounds over time

### Phase 7: Multi-Brand attribution
- `brands` table: RefundLocators / Defender HA
- Per-deal brand attribution
- Cross-brand analytics (LTV, CAC, revenue)
- Per-brand portal skinning (same backend, different theme)

### Phase 8: Ownership-transfer layer
- `access_grants` (named login sets with audit trail)
- One-click export: deals CSV + financial PDF + doc bundle + SOP archive
- Acquisition-readiness dashboard (pipeline value, monthly revenue run rate, retention, tech stack inventory)

**This is the layer that makes the business sellable with one login.**

### Smaller backlog items (can slot any time)
- System Health page (DB row counts, Castle heartbeat, deploy status, storage used) — mentioned in PROJECT_STATUS §12
- Daily backup pg_cron job → Nathan's inbox
- Credential consolidation in 1Password shared vault
- Commission tracking table + UI
- Post-recovery automation (`disbursement_ordered` → celebration + Nathan task + commission row)
- Email reply parsing (Nathan replies to notification email → DCC captures as message)
- Attorney notification preferences table
- `team_notification_prefs` so "who gets emailed" isn't hardcoded to Nathan

---

## 11 — The "business + life" expansion Nathan keeps mentioning

Nathan has consistently said: *"all encompassing brain for our business and our lives."* This means DCC grows past deals into:

### Business (beyond current scope)
- **Partners / referrers / vendors tracking** (Phase 2 contacts covers this)
- **Attorneys across all states** (contacts kind='attorney' covers this)
- **Press contacts, PR tracking**
- **Investors / cap table**
- **Hiring pipeline** (similar to leads table: new → interviewing → offer → hired)

### Life (new surface entirely — Phase 9?)
- **Personal tasks** not tied to deals (a separate `personal_tasks` table with `owner_id`-only RLS)
- **Journal / reflection** (time-series text, tag-able, private per owner)
- **Goal tracking** (quarterly OKRs, habits, daily check-ins)
- **Health logs** (routines, vitals, supplements — if Nathan wants)
- **Learning / reading library** (books, courses, notes)
- **Travel & plans** (trip itineraries, confirmations)
- **Family / kids** (events, milestones, documents)

**Stack stays the same** — React + Supabase + RLS. Tables get `owner_id` = auth.uid() only, no deal_id linkage. A "Life" top-level view in DCC shows personal stuff, hidden from everyone except the owner.

This is explicitly not a "Nathan's personal" vs "Justin's personal" distinction — each user's personal stuff is their own via RLS. If a VA logs in, they don't see Nathan's journal.

---

## 12 — How to do the merge (practical steps for Justin's Claude)

### Step 1 — Inventory Justin's side
Justin's Claude should output a list of:
- Migrations it has applied that are NOT in §3 above
- Edge Functions it has deployed that aren't in §5
- Tables it has created that aren't in §4
- Columns added to existing tables
- Triggers / RPCs added
- HTML/React components added
- Credentials stored anywhere

### Step 2 — Classify each item

For each: **keep as-is / merge into existing / rewrite to match convention / drop**.

Example:
- Justin: `SendSMS` Edge Function → **keep as-is**, it doesn't conflict with Nathan's side
- Justin: `contacts` table (if it exists separately on Justin's side) → **merge** with the existing `contacts` table (migration 20)
- Justin: credentials stored in a `.env` file somewhere → **migrate** to Supabase Vault or Edge Function secrets

### Step 3 — Produce a merge plan doc

Justin's Claude writes `JUSTIN_SIDE_INVENTORY.md` with:
- Every table/function/migration it added
- For each, a "keep / merge / rewrite / drop" verdict with rationale
- New tables that should go into the canonical list in §4 above

### Step 4 — Execute

Nathan's Claude + Justin's Claude split the merge work. Common failure mode to avoid: both Claudes applying the same migration concurrently. Coordinate via a "currently editing" note in this file OR by keeping all migrations flowing through one Claude at a time.

### Step 5 — Update this doc

Once merged, this brief becomes obsolete. Fold its content into `PROJECT_STATUS_AND_ROADMAP.md` (which is the living snapshot) and archive this file.

---

## 13 — The unified command center endgame

Here's what "one amazing CRM" looks like when done, in concrete terms. This is the picture both Claude sessions should work toward.

```
DCC (app.refundlocators.com)
├── Today
│     └── urgent + stale + bonuses + unfiled surplus + personal tasks
├── Pipeline
│     ├── Deals (surplus + flip + wholesale + rental + other)
│     ├── Leads (public intake + dup detection)
│     └── Contacts (CRM — attorneys, referrers, investors, vendors, press)
├── Client ops
│     ├── Client portal (homeowner-facing)
│     └── Counsel portal (attorney-facing)
├── Docket
│     ├── Events feed (Castle integration)
│     ├── Scraper health
│     └── Document OCR
├── Library
│     ├── SOPs
│     ├── Playbooks + templates
│     ├── Brand assets
│     └── Training videos
├── Financials (admin-only)
│     ├── Transactions
│     ├── Invoices
│     ├── Commissions
│     ├── Monthly P&L
│     └── Tax exports
├── Goals & Ideas
│     ├── OKRs
│     ├── Idea backlog
│     ├── Experiments
│     └── AI session log
├── Team
│     ├── Members + roles
│     ├── Hiring pipeline
│     └── Notifications prefs
├── Brands
│     ├── RefundLocators (surplus recovery)
│     └── Defender Homeowner Advocates (pre-auction)
├── System
│     ├── Health dashboard
│     ├── Backups
│     ├── Access grants + audit
│     └── Acquisition-readiness exports
└── Life (per-user RLS)
      ├── Personal tasks
      ├── Journal
      ├── Goals
      ├── Learning library
      └── Family / travel / health
```

One login. Every login sees only what their role + owner_id permits. When Nathan hits "Export everything" before selling, a single zip contains the business state across all columns — clean acquisition.

---

## 14 — Copy-paste prompt for Justin's Claude Code

When Justin is ready to merge, he can paste this verbatim into his Claude Code session:

> My business partner Nathan has been running a parallel Claude Code session on the same DCC Supabase project (`rcfaashkfpurkvtmsmeb`) and `deal-command-center` repo. He just pushed a merge brief at `COMMAND_CENTER_MERGE_BRIEF.md`.
>
> Do the following in order:
>
> 1. Read `COMMAND_CENTER_MERGE_BRIEF.md` end-to-end.
> 2. Read `PROJECT_STATUS_AND_ROADMAP.md`, `CLAUDE.md`, and `TRANSFER_TO_NEW_CLAUDE_CODE.md` for full context.
> 3. Using the Supabase MCP, run `list_migrations` and `list_tables` to confirm the actual shared state of the DB.
> 4. Produce a file `JUSTIN_SIDE_INVENTORY.md` that lists:
>    - Every migration you've applied (so we can check against Nathan's list of 27)
>    - Every Edge Function you've deployed
>    - Every table / column you've added
>    - Every trigger, RPC, or view you've created
>    - Every HTML/React component you've added
>    - Any secrets or credentials you've stored (locations only, no values)
> 5. For each item, mark it as: **keep / merge / rewrite / drop**, with one-sentence rationale.
> 6. Identify any specific known conflicts with Nathan's work (e.g., same migration name with different content, both sides editing same file, etc.).
> 7. Report back. Do NOT apply any merges yet — Nathan's Claude and you will coordinate after reviewing.
>
> The endgame Nathan has described: one amazing CRM, all-encompassing brain for business + life, code + thoughts + ideas + features + SOPs + financials, sellable with one login. Act accordingly. Respect the conventions in §7 of the merge brief.

---

## 15 — Status of this doc

- **Authoritative for**: Nathan's side inventory, conventions, roadmap
- **Gaps**: Justin's exact additions (Lauren pgvector, SMS functions, any new tables) need Justin's Claude to document
- **Update cadence**: refresh every session-ending major merge

If you're reading this 3 weeks from now and things have moved, check the git log + migrations list first, then come back here.

— End of merge brief.
