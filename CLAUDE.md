# Deal Command Center — AI Collaborator Primer

This repo is a lead/deal tracker for **RefundLocators** (flips + surplus fund cases). Read this file before making changes — it has the stuff that isn't obvious from reading the code.

## Backlog: file feature requests + bugs as GitHub Issues (REQUIRED)

When Justin or Nathan says *"I want to fix/add/change X"* and the work
isn't going to ship in the current session, **file a GitHub issue** at
`gh issue create` immediately. Don't just stuff it into the in-session
todo list — those evaporate when the session ends and the next session
starts blind.

The convention:
- `gh issue create --title "<surface>: <verb> <noun>"` — e.g. `Mobile: notification badges don't clear after viewing`
- Always attach a surface label: `mobile` (DCC iOS app), `web` (DCC web app), or `castle` / `ohio-intel` if that surface
- Add `bug` or `enhancement`
- Include a repro path (for bugs) or acceptance criteria (for features)
- Include implementation hints if you have any — file paths, hook names, table names
- Always include the date + who reported it, so future sessions can ping back

The backlog lives at https://github.com/TheLocatorOfFunds/deal-command-center/issues.
Triaging, prioritizing, and closing issues is the right way to track
what's getting done across sessions. PRs should reference the issue
they close with `Closes #N` in the body.

## Session start and end ritual (REQUIRED)

This repo is co-coded by Justin and Nathan, each running their own Claude Code sessions.
Cross-session state lives in `WORKING_ON.md`, `session_archives/`, and `DIRECTOR_DCC_INTERFACE.md`.
**You must run the session rituals so the other session doesn't work blind.**

### Starting a session
Run `/catchup` as your very first action. It pulls, reads WORKING_ON.md + recent session
archives + DIRECTOR_DCC_INTERFACE.md + recent commits, and produces a <300-word briefing
on what the other session shipped, what's in-flight, and any gotchas. Do not start work
until you have run it.

### Ending a session
Run `/handoff` before your last response. It audits what you shipped, decides if it's
substantive enough to archive (architectural decisions, migrations, edge function deploys,
non-obvious gotchas), writes the session_archives entry if so, updates your section in
WORKING_ON.md, and proposes a commit. **If you skip this, the next session starts blind.**

Both commands live in `.claude/commands/`. If you are running from outside the repo
directory and the slash commands are not available, manually do the equivalent:
- Start: `git pull`, read `WORKING_ON.md` + `session_archives/index.md` + `DIRECTOR_DCC_INTERFACE.md`
- End: update your section in `WORKING_ON.md` with status + what you shipped + open follow-ups,
  write a `session_archives/YYYY-MM-DD-<slug>.md` if the session was substantive, commit both

## Architecture at a glance

- **Source**: React JSX in `src/app.jsx` (~12,640 lines). Pre-compiled by **esbuild** to `app.js` (~483KB minified) via `npm run build`. **Edit `src/app.jsx`, NOT `index.html`.**
- **Shell**: `index.html` is now a 12KB shell that loads React + ReactDOM + supabase-js from CDN, then `<script src="app.js" defer></script>`.
- **Why the build step**: prior to 2026-04-26, JSX was inline in `index.html` and transpiled at runtime by Babel-Standalone. The file grew past Babel's 500KB deopt threshold and cold-loads were 10-15 sec. esbuild eliminates Babel-in-browser entirely; cold-load is sub-second.
- **Build workflow**: edit `src/app.jsx` → `npm run build` (~30ms) → `git add src/app.jsx app.js index.html` → commit + push. **Always commit `app.js` along with source — GitHub Pages serves it directly.**
- **Build tooling**: `package.json` + `build.js` + `node_modules` (gitignored). Run `npm install` once after cloning.
- **Backend**: Supabase project `rcfaashkfpurkvtmsmeb` — Postgres + Auth + Realtime.
- **Hosting**: GitHub Pages on `main` branch root. Any commit to `main` rebuilds in ~30s. URL: https://thelocatoroffunds.github.io/deal-command-center/ (custom domain: app.refundlocators.com).
- **Auth**: Magic-link (`signInWithOtp`). Users auto-create on first sign-in. Profiles auto-populate via `handle_new_user` trigger.
- **Mobile companion app**: `mobile/` directory — React Native + Expo (managed
  workflow), TypeScript, expo-router. Same Supabase project. Distributed via
  TestFlight for iOS internal alpha. See `mobile/README.md` for setup +
  `memory/mobile_app_plan.md` for v1 scope decisions. Domain: Justin.

## Credentials

Supabase URL + **publishable** (anon) key are hardcoded near the top of `src/app.jsx`:

```js
const SUPABASE_URL = 'https://rcfaashkfpurkvtmsmeb.supabase.co';
const SUPABASE_KEY = 'sb_publishable_...';
```

This is safe — the publishable key is designed for client-side use. RLS is what actually protects data. **Never** put the service-role key in this file.

### Supabase Personal Access Token (PAT) — for CLI deploys & Management API

The team already has a working PAT — **do not ask the user to generate a new
one** unless they explicitly say theirs has been revoked. It lives in two
places:

- **Justin's Mac (canonical):** `~/Library/Application Support/Claude/claude_desktop_config.json`
  under `mcpServers.supabase-dcc.env.SUPABASE_ACCESS_TOKEN`. One-liner to extract:
  ```bash
  PAT=$(jq -r '.mcpServers["supabase-dcc"].env.SUPABASE_ACCESS_TOKEN' \
    ~/Library/Application\ Support/Claude/claude_desktop_config.json)
  ```
- **GitHub Actions:** repo secret `SUPABASE_PAT` (used by `migrations-applied.yml`).

Use it for:
- `supabase functions deploy <name>` — when the CLI prompts for auth,
  `export SUPABASE_ACCESS_TOKEN=$PAT` first
- Management API calls: `curl -H "Authorization: Bearer $PAT" https://api.supabase.com/v1/...`
- Checking applied migrations, vault secrets, function deploys, etc.

**If you're a sandbox session without filesystem access to Justin's Mac**: ask
the user to paste it once, then proceed — but be aware it grants full account
access, so don't log it.

**⚠ IP allowlist gotcha (confirmed 2026-05-28):** the Supabase project has IP
allowlisting enabled on the **Management API**. Even with a valid PAT,
`supabase functions deploy` from a sandbox / cloud session returns
`403 Host not in allowlist`. Edge-function deploys have to run from a
whitelisted machine — Justin's Mac or the Defender Mini. Don't bother
attempting from a Linux sandbox; tell the user to deploy locally instead.
Read-only Management API calls (listing functions, reading vault secrets via
SQL, etc.) are *not* affected — the allowlist only blocks writes/deploys.

## Database schema

Core tables, all in `public` schema:

| Table | Purpose | Key columns |
|---|---|---|
| `profiles` | 1:1 with `auth.users` | `id` (uuid, FK to auth.users), `name`, `role` — one of `admin`, `user` (legacy admin), `va`, `attorney`, `client` |
| `deals` | The core entity | `id` (text PK), `type` ('flip' / 'surplus' / 'wholesale' / 'rental' / 'other'), `status`, `name`, `address`, `meta` (jsonb for flexible per-type fields), `owner_id` |
| `expenses` | Per-deal line items | `deal_id` FK, `category`, `amount`, `date`, `vendor`, `notes` |
| `tasks` | Per-deal todos | `deal_id` FK, `title`, `done`, `assigned_to`, `due_date` |
| `vendors` | Per-deal contractors/contacts (deal-scoped, different from `contacts`) | `deal_id` FK, `name`, `role`, `phone`, `email` |
| `deal_notes` | Per-deal notes (many-per-deal) | `id` (uuid PK), `deal_id` FK, `title` (optional), `body`, `author_id`, `created_at`, `updated_at` |
| `activity` | Audit log | `deal_id` FK, `user_id`, `action`, `created_at` |
| `documents` | Per-deal file metadata | `deal_id` FK, `name`, `path`, `size`, `uploaded_by` — actual files in `deal-docs` storage bucket |
| `client_access` | Links auth users to deals for the Client Portal | `user_id` (nullable until client signs up), `deal_id`, `email`, `enabled`, `last_seen_at`, `prefs` jsonb |
| `attorney_assignments` | Auth-scoping table the attorney portal reads. **Auto-synced from `contact_deals`** — when a `contacts.kind='attorney'` row is linked to a deal, a trigger creates/updates the matching `attorney_assignments` row. Nathan edits `contacts` in DCC; access-control stays in lockstep. | same shape as `client_access` |
| `messages` | Two-way threads team ↔ client ↔ attorney per deal | `deal_id` FK, `sender_role`, `sender_id`, `body`, `created_at` |
| `leads` | Public intake form submissions | `id`, `name`, `email`, `status`, `metadata` jsonb (UTM + dup detection) |
| `docket_events` | Matched docket events from Castle | `deal_id` FK, `external_id`, `event_type`, unique(deal_id, external_id) |
| `docket_events_unmatched` | Staged events Castle sent before DCC had a matching deal | — |
| `scrape_runs` | Castle heartbeats (one row per county per monitor run) | — |
| **`contacts`** | **Company-wide CRM entities** (partner attorneys, title companies, investors, referral sources, partners, vendors at company level, press, competitors) — intentionally separate from `vendors` (per-deal) and `leads` (intake) | `id` (uuid PK), `name`, `company`, `email`, `phone`, `kind`, `tags` text[], `notes`, `financial_notes` (admin-only UI), `owner_id`, **`do_not_text` boolean**, **`do_not_call` boolean**, **`dnd_set_at`**, **`dnd_reason`** (DND added 2026-04-25) |
| **`contact_deals`** | **Many-to-many** between `contacts` and `deals` | `contact_id` FK, `deal_id` FK, `relationship`, unique(contact_id, deal_id) |
| `outreach_queue` | Justin's AI-drafted SMS pipeline (PR #12) | `deal_id`, `contact_phone`, `cadence_day` (0=intro, 1/3/5 + weekly through 90 = drips), `status` (queued / generating / pending / sent / skipped / failed / **cancelled**), `scheduled_for`, `draft_body`, `sent_at`, `message_id` |
| `messages_outbound` | Justin's SMS table (also receives inbound) | `deal_id`, `direction` (`inbound` / `outbound`), `to_number`, `from_number`, `body`, `twilio_sid`, `contact_id`, `thread_key`, `channel` (sms / imessage), **`read_by_team_at`** (added 2026-04-25 for Reply Inbox) |
| `personalized_links` | Castle-owned. Token-based URLs at refundlocators.com/s/{token} | `token` (8-char nanoid PK), `deal_id` (nullable for orphan auction-discovered), `first_name`, `last_name`, `phone`, **`mailing_address`**, **`claim_submitted_at`** (added 2026-04-25 — were missing, broke claim flow), `property_address`, `county`, `case_number`, `sale_date`, `sale_price`, `judgment_amount`, `estimated_surplus_low/_high`, `expires_at`, `responded_at`, `view_count` |
| `library_documents` | **Phase 3 Library — populated 2026-04-26.** Reusable templates / SOPs / brand assets that get pinned-to or attached-to deals | `id`, `folder_id`, `title`, `description`, `path` (storage), `kind` (`file` / `template` / `video` / `image` / `link`), `tags` text[], `visibility` (admin_only / team / attorney / client), `template_fields` jsonb (for DocuSign merge), `docusign_template_id`, `extracted` jsonb (Claude Vision OCR) |
| `library_folders` | Org structure for `library_documents` | `id`, `name`, `parent_id`, `visibility`, `icon` |
| `deal_library_pins` | Per-deal expose-without-copying for library docs | `deal_id`, `library_document_id`, `pinned_for` (client / attorney) |
| `castle_health_log` | Daily snapshots from `castle-health-daily` Edge Function (Castle agent) | `snapshot_date`, `agents` jsonb (full v_scraper_health row), `severity` (green / transient / chronic / critical), `summary` (Claude prose), `recommendations` jsonb, `email_sent` |
| `scraper_agents` | Catalog of Castle's 5 monitor agents (owned by ohio-intel session, lives in DCC's project) | `agent_id` PK, `display_name`, `cadence_minutes`, `grace_minutes`, `uses_selenium`, `county_scope`, `enabled` |
| `v_scraper_health` (view) | Computed health per agent — green/yellow/red based on cadence + grace | reads `scraper_agents` + `scrape_runs` |
| `court_pull_requests` | DCC → Castle queue: "scrape this case on demand" | `deal_id`, `case_number`, `county`, `status`, `documents_added`, `events_added` |
| `foreclosure_cases` | Castle auction sweep target — sheriff sale calendar | `case_number`, `county`, `property_address`, `sale_date`, `sale_price`, `judgment_amount`, `estimated_surplus_low/_high` |

`docket_events` also gained 3 columns 2026-04-25: `litigation_stage` (text), `deadline_metadata` (jsonb), `attorney_appearance` (jsonb) — Castle's K.1/K.3/H.b sprint emissions.

All child tables cascade-delete when the parent deal is deleted. `contact_deals` cascades when either the contact or the deal is deleted.

## RLS model (important — read before modifying)

Four-tier model driven by `profiles.role`:

- **Admin** (`role IN ('admin', 'user')`, Nathan/Justin): full access via `admin_all_*` policies on every table.
- **Virtual Assistant** (`role = 'va'`): access to deals, tasks, vendors, activity, deal_notes, documents, client_access, contacts, contact_deals. **No access to `expenses`.** UI also hides financial fields in `deals.meta` AND `contacts.financial_notes` (trust-based — same pattern applies to both jsonb keys and the `financial_notes` column).
- **Attorney** (`role = 'attorney'`): scoped read-only access to deals they're assigned to via `attorney_assignments`. Can add activity rows and upload documents on their assigned deals. Cannot see other deals or financials.
- **Client** (`role = 'client'`): portal-only. Scoped access via `client_*` policies to rows linked to them through `public.client_access`. Cannot access `expenses`, `tasks`, `vendors`, `deal_notes`.

Helpers (all `SECURITY DEFINER` so they bypass profile RLS):
- `public.is_admin()` — true when role is `'admin'` or `'user'`
- `public.is_va()` — true when role is `'va'`
- `public.is_attorney()` — true when role is `'attorney'`
- `public.is_client()` — true when role is `'client'`
- `public.my_case_claimant_count()` — lets a client see how many claimants share their case (for multi-claimant portal context)

The `handle_new_user` trigger auto-assigns `role` at signup:
1. Email matches pending `client_access` → role = `'client'`, links user_id
2. Else email matches pending `attorney_assignments` → role = `'attorney'`, links user_id
3. Else → role = `'user'` (admin). Future tightening: require admin approval before granting team access.

The three apps:
- **DCC** (`index.html`) — team app. Admins get everything; VAs get everything but expenses + financial fields hidden at UI level; admin can manage team via Team modal.
- **Client portal** (`portal.html`) — clients sign in here. UI only queries `deals`, `activity`, `documents`, `client_access` (all scoped by RLS). Multi-claimant aware. Features welcome video, status intel, timeline expectations, empathy check-in, post-recovery celebration.
- **Counsel/attorney portal** (`attorney-portal.html`) — attorneys sign in, see a list of cases they're assigned to via `attorney_assignments`, can open any case to view status, timeline, documents, and team notes. Can post case updates (RPC `attorney_post_update` → writes to activity feed) and upload documents. Scoped entirely by RLS. Hash-based routing (`#/` for inbox, `#/case/:id` for detail). Admin invites from the deal detail via the Counsel Portal card in SurplusOverview.

## Automation

- **Daily digest** ("morning sweep"): Edge Function `morning-sweep` runs at 12:00 UTC (8am EDT / 7am EST) via pg_cron job `morning-sweep-daily`. Walks every active deal, detects overnight activity, refreshes Claude case summaries on changed deals, sends an email via Resend to nathan@fundlocators.com + justin@fundlocators.com. Resend key in Vault under `resend_api_key`. Full doc: `docs/MORNING_SWEEP.md`. **The legacy `daily-digest-nathan` cron + `public.send_daily_digest()` pg function were retired 2026-04-27 (migration `20260428000000_retire_daily_digest_nathan.sql`) — they were a duplicate firing at the same minute.**
- **Document OCR**: Supabase Edge Function `extract-document` reads uploaded files (images + PDFs) and sends them to Claude Vision (claude-sonnet-4-5). Returns structured JSON: `document_type`, `confidence`, `fields` (type-specific extraction), `summary`, `notes`. Stored on `documents.extracted` jsonb + `extraction_status`. Requires `ANTHROPIC_API_KEY` env var in Edge Function secrets. Auto-fires on upload; manual retry via UI.
- **Weekly empathy check-in**: clients can call `public.client_empathy_checkin(p_mood, p_response)` once per week. Mood is one of `good`, `struggling`, `need_help`. Logs an activity row on the deal (so Nathan sees it) and appends to `client_access.prefs.empathy_checkins` history. Portal shows the prompt when last check-in was >7 days ago or never.
- **Welcome video**: stored per deal at `deals.meta.welcome_video.path` (pointing to the `deal-docs` bucket). Portal fetches a signed URL on load and embeds above the case status.

## Role-based UI gating

The UI visibility of financial data is driven by `profile.role`:
- **Admin** (`user` | `admin`): sees everything — dashboard $ tiles, Projected Revenue, deal detail metric strip, Live P&L Waterfall, Deal Parameters card, Financial Summary card, Case Details financial fields (estimatedSurplus, feePct, attorneyFee), the Expenses tab, Analytics view.
- **VA** (`va`): everything EXCEPT the above financials. Dashboard shows 3 tiles instead of 5. Deal detail metric strip shows Type/County/Attorney instead of dollar metrics. Expenses tab is hidden (RLS also blocks data access). Case Details hides financial inputs but keeps attorney/case number/county.
- **Attorney** / **Client**: no DCC access; they use their own portal pages.

## Realtime

The app subscribes to Postgres changes on `deals` (global) and on all 5 child tables scoped to the active deal. Two users editing simultaneously see each other's changes live. If you add a new table that should sync, add a `.on('postgres_changes', ...)` subscription in the matching component.

## Deployment flow

1. `git clone https://github.com/TheLocatorOfFunds/deal-command-center.git`
2. `npm install` (one-time — installs esbuild)
3. Edit `src/app.jsx` (NOT `index.html` — `index.html` is a 12KB shell, all React lives in `src/app.jsx`)
4. `npm run build` (~30ms — outputs minified `app.js`)
5. **Test locally:** open `index.html` in a browser — works via `file://` since React/ReactDOM/supabase load via CDN. Auth + Supabase calls work.
6. `git add src/app.jsx app.js index.html` + `git commit -m "..."` + `git push`
7. Wait ~30s, refresh https://app.refundlocators.com (or thelocatoroffunds.github.io/deal-command-center/)

**Forgot to run `npm run build` before commit?** GitHub Actions auto-rebuilds (`.github/workflows/build.yml`). If `app.js` is stale relative to `src/app.jsx` on push, the action runs `npm run build` + commits the rebuilt artifact back to `main` with `[skip ci]` to avoid loops. So the deploy still works — it just adds a follow-up commit.

No staging environment. Commits to `main` go live. Coordinate with the team before big changes.

## Top-level views (current sidebar, top → bottom)

Several sidebar entries are **hubs** — one nav item whose second-level chip bar
switches between sibling sub-views (see `groupBtn`/`chipBtn` in `src/app.jsx` ~line 3032).

1. **📌 Today** — daily dashboard: KPI tiles + pipeline funnel + AutomationsQueue (pending outreach drafts) + Prep Queue + Urgent + Team Activity (right rail)
2. **⚡ Attention** — reactive: cross-deal deadline strip + 🔥 Lead Engagement strip (link opens + Lauren chats) + per-deal unread/unacked work
3. **🎯 Outreach** (hub) — `outreach` (Drafts & Replies: 4 stat tiles + AutomationsQueue + ReplyInbox) · `inbox` · `leads` (LeadsOutreachView) · `forecast` (7–14 day plan)
4. **📡 Relay** — cadence/sequence auto-enrollment engine (relay_enrollments, "Ohio Surplus Funds v1" sequences, approve/skip/regenerate per scheduled step)
5. **🏠 Deals** (hub) — `active` · `flagged` · `hygiene` · `archive` (Closed) · `pipeline` (kanban) · `leads-phase` (New Leads / prep-readiness)
6. **✅ Tasks** — global task list across deals
7. **⏱ Time** — team time tracking (admin only)
8. **📊 Insights** (hub, admin) — `reports` (+ ScraperHealthPanel) · `analytics` (financial) · `traffic` (web) · `comms` (CommsAnalyticsView)
9. **📞 Calls** — call history (CallHistoryView)
10. **💬 Chat** — team chat + Lauren (TeamView)

Sidebar entries that open **modals** (not views): **👥 Contacts**, **⚖ Docket**, **📋 Leads** (intake/dup), **📥 Import** (admin), **📚 Library**. Header also has 🔍 Search (⌘K), the 🔔 notification bell, and the Phone dialpad popover. A mobile "More" sheet mirrors the secondary items.

> **Known IA overlaps** (from the 2026-05-26 redesign audit; redesign shelved, see git `176549c`/`720a669`): two outreach engines run in parallel (Outreach `outreach_queue` "Automations" vs **Relay** sequences) and can queue the same lead; the AutomationsQueue + Team Activity render on both Today and Outreach; the Outreach "Drafts ready" tile counts ALL pending while the queue below shows only the active phase (A-tier verified surplus). Incremental cleanups tracked separately — don't assume these are intentional when navigating.

## Common change recipes

### Add a new field to deals
1. In Supabase SQL editor: `alter table deals add column foo text;` — or add inside `meta` jsonb to avoid migrations.
2. In `src/app.jsx`, add the field to `NewDealModal`, `DealDetail`, and (if it should show on the card) `DealCard` / `SurplusCard`.
3. `npm run build` + commit.

### Add a new deal type (e.g. "wholesale")
1. Add the type to `DEAL_STATUSES` (new array of stages).
2. Add status colors to `STATUS_COLORS`.
3. Add a case in `DealList` to render a section for it.
4. Add a card component if the layout should differ from `DealCard`.
5. `npm run build` + commit.

### Add a new user
Nothing to do in the dashboard — just share the URL. First sign-in auto-creates the `auth.users` row and the `profiles` row via trigger.

### Invite a VA with limited access
1. Add them via magic link (same flow).
2. In SQL, set `update profiles set role = 'va' where id = '...';`
3. Tighten RLS policies to check `role` (currently nothing does).

## Gotchas

- **Babel in the browser is slow on cold load** (~1s). Don't panic — it's not broken.
- **No TypeScript, no linter.** Be careful with typos; errors surface at runtime in the console.
- **`meta` jsonb is a grab-bag.** When you add fields there, they're schema-less. Be consistent — document new fields here if they're important.
- **Status strings are lowercase with hyphens** (`under-contract`, `new-lead`). Don't change the casing without updating `STATUS_COLORS` and seed data.
- **Deal IDs are text, not uuid.** Existing ones: `flip-2533`, `sf-sizemore`, `sf-caldwell`, `sf-creech`, `sf-depew`. Pattern for new flips: `flip-<streetnumber>`. For surplus cases: `sf-<lastname>`.
- **The `activity` table is write-heavy.** Every edit logs. If you add a bulk-edit feature, batch the inserts.
- **`vendors` is per-deal, `contacts` is company-wide.** Don't conflate them. A contractor who does one flip goes in `vendors`. A partner attorney who touches multiple cases goes in `contacts` and gets linked via `contact_deals`.
- **`contacts.financial_notes` is a column, not jsonb.** UI hides it for VAs, but RLS allows VA reads (same trust-based pattern as `deals.meta` financial fields). If you ever need tighter enforcement, use a column-level privilege or a VIEW.
- **Attorney portal access flows contacts → attorney_assignments via trigger.** `tg_sync_attorney_assignments_from_contact_deal` fires on `contact_deals` insert/update/delete and keeps `attorney_assignments` aligned whenever an attorney-kind contact is linked to (or unlinked from) a deal. Matching `tg_sync_*_on_contact_update` and `_on_contact_delete` triggers handle edits to the contact row itself. Do NOT manually insert into `attorney_assignments` alongside `contact_deals` — let the trigger do the work, or you'll end up with double rows.

## Team

- **Nathan** (nathan@refundlocators.com) — owner
- **Justin** (justin@refundlocators.com) — co-founder / developer

## Domain ownership (two parallel Claude Code sessions)

Nathan and Justin each run their own Claude Code session on the same repo and Supabase project.
**Before touching anything, check this table.** If you're Justin's Claude and something is in
Nathan's column — leave it alone and ask. Same in reverse.

| Domain | Owner | Key files / tables |
|---|---|---|
| SMS / Twilio outbound + inbound | **Justin** | `messages_outbound`, `phone_numbers`, `supabase/functions/send-sms`, `supabase/functions/receive-sms`, `OutboundMessages` component in `index.html` |
| iMessage bridge (Mac Mini daemon) | **Justin** | TBD — not yet built |
| Client portal | **Nathan** | `portal.html`, `client_access` table, `client_empathy_checkin` RPC |
| Attorney/counsel portal | **Nathan** | `attorney-portal.html`, `attorney_assignments` table, attorney triggers |
| Castle / docket integration | **Nathan** | `docket_events`, `docket_events_unmatched`, `scrape_runs`, `supabase/functions/docket-webhook` |
| Email / Resend triggers | **Nathan** | `messages_email_notify`, `docket_events_client_notify`, `send_daily_digest` |
| Lead intake + dup detection | **Nathan** | `lead-intake.html`, `leads` table, `find_lead_duplicates` RPC |
| Lauren / pgvector AI chat | **Both (co-owned)** | `lauren_*` tables, pgvector embeddings — Nathan + Justin own equally; coordinate before substantive changes (per Nathan, 2026-05-05) |
| Phase 3 Library | **Nathan** | Designed — not yet built |
| Phase 4 Financials | **Nathan** | Not yet built |
| **DCC Mobile companion app** | **Justin** | `mobile/` — Expo + React Native, TestFlight distribution. v1 scope still being decided with Nathan. See `memory/mobile_app_plan.md`. |
| **Shared (either can touch)** | Both | `deals`, `vendors`, `tasks`, `expenses`, `activity`, `deal_notes`, `documents`, `contacts`, `contact_deals`, `index.html` shell + nav + shared components |

**When in doubt**: don't write migrations or edit Edge Functions in another owner's domain.
Post a note and wait for the other session to coordinate.

## Cross-project: intel-main interface

DCC is not standalone — Nathan also runs **intel-main** (`~/Documents/Claude/main-intel/`,
Vercel-hosted, separate Supabase project `qbdslghonhuvkacqlsbd`) which writes into DCC.
The contract is documented in **[`DIRECTOR_DCC_INTERFACE.md`](./DIRECTOR_DCC_INTERFACE.md)** —
read it before touching `deals`, `intel_subscriptions`, `intel-sync`, `ohio-intel-to-deal`,
or any of the intel-main-managed `deals.meta` fields.

**Hot rules** (the rest is in the interface doc):
- intel-main writes these `deals.meta` keys via initial push + 30-min `sync-deal-updates`
  cron. **Do not manually mutate them in DCC code or SQL** — if you need a change, do it
  through intel-main and the next cron reconciles within 30 min:
  `intel_case_id`, `intel_main_url`, `county`, `courtCase`, `grade`, `gradeScore`,
  `estimatedSurplus`, `salePrice`, `judgmentAmount`, `totalDebt`, `courtAppraisalValue`,
  `minimumBidAmount`, `saleDate`, `auctionStatus`, `auctionUrl`, `plaintiffName`,
  `parcelId`, `foreclosureType`, `isPostAuction`, `surplusClaimStatus`, `walkerVerified`,
  `walkerPlatform`, `lifecycleStage`, `buyerName`, `lastIntelSyncAt`,
  `sourced_from`/`sourced_at`/`sourced_by`. Full source-of-truth table in
  `DIRECTOR_DCC_INTERFACE.md`.
- When intel-main inserts a deal, `tg_ensure_intel_subscription` fires automatically. **Do
  not manually insert into `intel_subscriptions` after a deal insert** — PK-collides and
  rolls the deal back. This is why `ohio-intel-to-deal` EF is currently bypassed.
- Bump the `Last updated` date at the top of `DIRECTOR_DCC_INTERFACE.md` whenever you
  change something on this contract.

## Co-coding protocol (read every session)

### Session start ritual
```bash
git pull                                    # always — Nathan / Erik may have pushed
cat WORKING_ON.md                           # see what each session is currently doing
ls session_archives/                        # skim recent archives for relevant context
cat session_archives/index.md               # one-line summaries of past sessions
```
Then update **your own section** of `WORKING_ON.md` with what you're about
to work on. Per-user sections (Justin / Nathan / Erik) — edit only your own.

### Branch strategy
- Work on a short-lived branch: `git checkout -b justin/your-feature-name`
- Push the branch, open a PR, merge to `main` when done
- `main` is what GitHub Pages serves — only stable, tested work goes there
- Never force-push to `main`

### Migration protocol
1. `git pull` before writing any migration
2. Check `ls supabase/migrations/` — find the latest timestamp
3. Increment by 1 second for your new migration filename
4. Apply via Supabase SQL editor (not `supabase db push` — no local DB)
5. Commit the `.sql` file in the same commit as the feature that needs it

**Step 4 is the trap.** Skipping it ships UI that depends on schema that
doesn't exist in prod yet — every fetch errors out and the app silently
falls back to defaults. This is exactly how 2026-05-07 took the entire
DCC down for ~30 minutes (soft-delete PR shipped `WHERE deleted_at IS NULL`
without applying the column-add migration).

**Guardrail:** the `.github/workflows/migrations-applied.yml` workflow runs
on every PR + every push to main. It compares files in
`supabase/migrations/` against migrations actually applied to prod (via
the Supabase Management API) and fails the build with the list of missing
files. Requires repo secret `SUPABASE_PAT` — Personal Access Token from
https://supabase.com/dashboard/account/tokens. If the check fails:
1. Open the SQL Editor link the workflow logs print
2. Paste each missing file's contents and click Run
3. Push a new commit (or re-trigger the workflow) to confirm green

### Live state — update WORKING_ON.md as you work
Don't wait for session end. As you make decisions or shift focus,
update YOUR section of `WORKING_ON.md` and push (small commits are
fine). Other sessions running concurrently `git pull` to refresh — so
the more recent your section is, the less likely they are to step on
your work. Conflict-free as long as everyone edits only their own
section. **Never edit another user's section.**

**Multiple worktrees as the same user**: if you run two Claude Code
worktrees in parallel (e.g. Justin running `claude/foo-bar` AND
`claude/baz-qux` simultaneously), the Stop hook auto-creates a
per-worktree subsection `### <Your name> · <worktree-slug>` inside
your top-level user section. Each worktree updates only its own
subsection — no race. Your manual notes about "what I'm working on"
can go either at the user-section level (high-level status) or
inside a specific worktree subsection (fine-grained per-branch).
Subsections from finished worktrees can be pruned manually.

### Session end ritual
1. Commit everything (including any migration files).
2. Update **your own section** of `WORKING_ON.md` — mark idle if you
   wrapped, note "crashed at <step>, resume from <file>" if you didn't.
3. **If the session was substantive** (architectural decisions made,
   non-obvious gotchas hit, or work future sessions need to know about):
   write a `session_archives/YYYY-MM-DD-<short-slug>.md` entry using
   the template at `session_archives/_TEMPLATE.md`, and add a one-line
   summary to `session_archives/index.md`. Skip for trivial sessions
   (typo fixes, small bug PRs — those are sufficiently captured in the
   PR + git log).
4. Push branch (or merge to `main` if it's stable and tested).

### Why this matters
Multiple Claude Code sessions run in parallel — Justin, Nathan, Erik,
each sometimes with a couple of worktrees going. Without live state in
`WORKING_ON.md` and durable learnings in `session_archives/`, every
session re-discovers the same architectural quirks (iframe forms,
Twilio JWT flag, Postgres function overload ambiguity, etc.). The
convention above closes the loop: live state for "what's happening
now," archives for "what's been figured out before," `memory/` for
"what survives across many sessions."

### Stop hook safety net (`.claude/hooks/touch-working-on.sh`)
A Stop hook fires after every Claude turn and updates a
`**Last updated (auto):**` timestamp in your **per-worktree subsection**
of `WORKING_ON.md` — automatically, even if Claude itself forgets to
update its content. The hook:
- Maps your `git config user.email` (or fallback `$USER`) → DCC name
  (`Justin`/`Nathan`/`Erik`)
- Detects the current worktree slug (`basename $(git rev-parse --show-toplevel)`,
  or "main" if you're in the main worktree)
- Finds/creates a `### <Your name> · <worktree-slug>` subsection inside
  your top-level `## <Name>'s session` section
- Updates the timestamp line **only inside that subsection** — never
  touches other users' sections, never touches your other worktrees'
  subsections
- Auto-commits the heartbeat if the file's last commit is > 2 min old,
  with message `chore(working_on): <Name> heartbeat (auto, <slug>)`
  (avoids commit spam while still surfacing state to other sessions
  on their next `git pull`)
- Never pushes — Claude pushes as part of normal commit flow
- Always exits 0 (best-effort; never blocks a session)

This closes the failure modes where Claude forgets to update on its
own — context compaction dropping the rule, auto-mode skipping
"non-essential" reads, subagents not following the convention,
focus drift over long sessions, and mid-session crashes. The
timestamp moves regardless. Other sessions can see "active 2 min
ago" vs "stale 6 hours, probably crashed."

**Per-worktree subsections also fix the race condition** where a single
user running two parallel worktrees would have both hooks fighting over
the same user-level section, producing merge conflicts on shared lines.
Each worktree now owns its own subsection. Subsection naming is stable
(based on worktree path), so the hook is idempotent across runs.

If the hook ever causes problems, disable it for a specific worktree
by adding `"hooks": {"Stop": []}` to that worktree's
`.claude/settings.local.json` (gitignored, local-only). The convention
still works without it, just less robustly. Disable repo-wide only as a
last resort by removing the `Stop` block from `.claude/settings.json`.

### RLS convention (hard rule — applies to both sessions)
Always use the helper functions — never inline role checks:
```sql
-- ✅ Correct
using (public.is_admin())
using (public.is_admin() OR public.is_va())

-- ❌ Wrong
using ((select role from public.profiles where id = auth.uid()) = 'admin')
```

### Email templates brand rule
**Client-facing** email copy says **RefundLocators**, never FundLocators.
Sender for client/lead/partner mail: `RefundLocators <hello@refundlocators.com>` (Resend-verified via DKIM).

**Internal exec mail** (founder-to-founder briefings — `monday-memo`, `morning-sweep` CEO digest, anything between Nathan and Justin) uses the FundLocators LLC brand and sends from `hello@fundlocators.com`. That's intentional: those go to the founders, not customers, and FundLocators is the parent LLC. The "never FundLocators" rule above applies only to outbound to non-founders.

### Inbound email reality (Apr 22, 2026)
`refundlocators.com` has **no MX records** — Nathan doesn't have a real mailbox
at `nathan@refundlocators.com`. Notifications + reply-to use **`nathan@fundlocators.com`**
(Google Workspace, MX-backed). See trigger functions `dispatch_message_notifications`
and `send_daily_digest`, plus `mailto:` links in `portal.html` and `lead-intake.html`.

**Future cleanup to get `nathan@refundlocators.com` reachable** (Nathan wants this
eventually): Cloudflare Email Routing is the intended path. It's blocked right now
because the apex `refundlocators.com` has a proxied CNAME → `refundlocators.pages.dev`
(the public marketing site), and Email Routing refuses to add MX records at an apex
that already has a proxied CNAME (error: "Duplicated Zone rule"). The fix is to move
the marketing site off the apex:

1. Delete the apex `CNAME refundlocators.com → refundlocators.pages.dev` in Cloudflare DNS
2. Keep `CNAME www → refundlocators.pages.dev`
3. Add a **Bulk Redirect** rule in Cloudflare: `refundlocators.com/*` → `https://www.refundlocators.com/$1` (301)
4. Enable Cloudflare Email Routing (Email → Email Routing → Get started): custom address `nathan` → destination `nathan@fundlocators.com`, then also add a catch-all `*@refundlocators.com → nathan@fundlocators.com`
5. Revert the trigger functions + mailto links in one commit back to `nathan@refundlocators.com`

Do NOT delete `TXT resend._domainkey` or `TXT _dmarc` under any circumstance —
those are the active outbound sending config. SES leftovers (`MX send` and `TXT send`
with `include:amazonses.com`) were deleted Apr 22, 2026 and do not need to come back.

## e-signature integration — two parallel surfaces

DCC has TWO independent signing pipelines, both production-live:

### DocuSign (legacy, $500/yr Starter tier)
- **EF**: `docusign-send-envelope` / `docusign-sign` / `docusign-status` / `docusign-webhook`
- **Table**: `docusign_envelopes`
- **Template column**: `library_documents.docusign_template_id`
- **UI**: `DocuSignSendModal` in `src/app.jsx`, amber button in the Documents section
- **Status**: stuck on Starter — production embedded signing requires Enterprise ($2,500/yr). Sandbox-only until we pay or migrate.

### eSignatures.com (added 2026-05-14 — pay-as-you-go)
- **EF**: `send-esignature-contract` (REST) + `esignatures-webhook`
- **Table**: `esignatures_contracts`
- **Template column**: `library_documents.esignatures_template_id`
- **UI**: `ESignaturesSendModal` in `src/app.jsx`, green button in the Documents section
- **MCP server**: `mcp-server-esignatures` published on PyPI. Project `.mcp.json` exposes 13 tools (create / query / withdraw / delete / list contracts; create / update / query / delete / list templates; 3 collaborator tools). Token source: https://esignatures.com/api_accounts → Automation & API tab.
- **Cost**: $0.49/contract pay-as-you-go, $50 minimum top-up, no monthly floor.

### When to use which surface

| Trigger | Surface | Why |
|---|---|---|
| Nathan/Eric/Inaam clicks Send in DCC UI | REST/EF (either provider) | UI calls Edge Function; UI has no MCP access |
| Inbound webhook from vendor | EF (`docusign-webhook` or `esignatures-webhook`) | HTTP-only by definition |
| Justin in a Claude Code chat: "send the Retention to Elaine" | MCP (eSignatures) | One tool call, no UI round-trip |
| Lauren autonomous flow: "client said ready" | MCP (eSignatures) | Agent-native interface |
| Research agent: "lead graded A, send retainer" | MCP (eSignatures) | Agent-native interface |

### Critical UX caveat for the MCP path

The MCP `create_contract` tool may NOT honor `signature_request_delivery_methods=[]` the way the REST/EF path does. We built the EF to suppress eSignatures.com's own email/SMS so we can deliver the signing URL via Nathan's iPhone bridge (homeowner-on-an-iPhone UX). If you use the MCP server to send a contract, eSignatures.com will probably email/SMS the signer from a `noreply@esignatures.com` address — which is a worse experience for elderly surplus-fund homeowners.

**Rule of thumb**: for envelopes that go to homeowners, use the DCC UI (which goes through the EF). For internal / professional recipients (attorneys, vendors) where a `noreply` sender is fine, the MCP path is faster.

### Records reconciliation

Both surfaces should write to `esignatures_contracts`. The webhook EF reconciles either way — when a contract is created via MCP that DCC didn't originate, the first `signer-viewed-the-contract` webhook event inserts a stub row keyed on the `metadata.deal_id` we pass in the MCP call.

If you create a contract via MCP and want it to appear in DCC, set the `metadata` field to `{"deal_id": "<dcc-deal-id>", "source": "mcp"}` so the webhook can stitch it together.

## ⚠️ Messaging gateway — ALWAYS use Nathan's iPhone, NEVER Twilio

**All outbound SMS, MMS, and video is sent via Nathan's iPhone through the mac_bridge.**
Twilio is NOT used for outbound messages. Do not build Twilio outbound paths. Do not suggest Twilio for video or MMS.

The routing is automatic: Nathan's iPhone number is registered in `phone_numbers` with `gateway = 'mac_bridge'`.
The `send-sms` edge function reads that row and returns `pending_mac` — the bridge daemon on the Mac Mini picks it up and fires it via iMessage/SMS from the iPhone.

If you find yourself writing Twilio API calls for outbound messaging: stop, delete it, and use mac_bridge instead.

The only Twilio code that exists is the legacy fallback in `send-sms/index.ts` — leave it there in case a non-bridge number is ever added, but it is NOT the active path and should not be extended.

## Mac Mini (Defender Mini) — SSH access

Claude can SSH directly into the Mac Mini to deploy bridge fixes without any manual steps.

```bash
ssh defender-mini   # resolves to dealcommandcenter@defender-mini.local
```

### Autostart mechanism changed 2026-05-27 — Login Item, NOT launchd

After the Sequoia restore, the `com.refundlocators.bridge` LaunchAgent
got wedged (`launchctl bootstrap` → `Input/output error 5`, even from the
GUI session; not a disabled-override, plist lint-clean, node fine — a
corrupted launchd registration for that label). Rather than fight it, the
bridge now autostarts via a **macOS Login Item**:

- `~/Applications/DCCBridge.app` — a tiny AppleScript launcher that
  `cd`s to the bridge dir, kills any stale `bridge.js`, and starts a fresh
  `node bridge.js` detached (logging to `/tmp/dcc-bridge.log`). Registered
  as a Login Item ("DCCBridge") for `dealcommandcenter`.
- The old LaunchAgent plist was moved to
  `~/Library/LaunchAgents/com.refundlocators.bridge.plist.disabled-superseded-by-loginitem`
  so it can't double-start the bridge at login. Do NOT re-add it.

**Why a Login Item and not launchd:** the bridge drives Messages.app via
AppleScript, which ONLY works inside the logged-in Aqua/GUI session. A
process started over SSH (or by a system daemon) gets
`OSLaunchdErrorDomain Code=125 "Domain does not support specified action"`
when it tries `open -a Messages`. The Login Item runs in the GUI session,
so it can send. This is also why **you cannot fully deploy a bridge change
over SSH** — see below.

**Deploying a `mac-bridge/bridge.js` change (two steps; the restart can't
be done over SSH):**
```bash
# 1. Pull the new code (works over SSH):
ssh defender-mini "cd /Users/dealcommandcenter/Documents/deal-command-center && git pull && grep -c <your-new-symbol> mac-bridge/bridge.js"
```
Then **restart the bridge FROM THE GUI SESSION** (an SSH restart can't
drive Messages.app). Either relaunch `~/Applications/DCCBridge.app`
(double-click, or in a Terminal *on the Mini*: `open ~/Applications/DCCBridge.app`),
or log out and back in — the Login Item re-fires with the new code.

Check bridge logs anytime (read-only, fine over SSH):
```bash
ssh defender-mini "tail -50 /tmp/dcc-bridge.log"
```

SSH key: `~/.ssh/defender_mini` (ed25519). **Note (2026-05-27):** the
Sequoia restore wiped `authorized_keys`; re-add with
`ssh-copy-id -i ~/.ssh/defender_mini.pub dealcommandcenter@<ip>` if SSH
stops working after a future restore. The host's `.local` name can also
go stale — connect by LAN IP (e.g. `192.168.1.12`) if `defender-mini`
times out.

**Bridge repo path** (the one the Login Item runs from):
`/Users/dealcommandcenter/Documents/deal-command-center/` — bridge starts
with cwd = its `mac-bridge/` subdir so `dotenv` finds `mac-bridge/.env`.

**⚠ Trap (2026-05-13):** there's ALSO a stale clone at
`/Users/dealcommandcenter/Documents/DealCommand Center/deal-command-center/`
(with a space + "DealCommand Center/" subdirectory). The bridge does NOT
run from there. Earlier versions of this doc pointed there; SSH-deploys
to that path silently succeeded but never updated the running daemon.
If a deploy "succeeds" but behavior doesn't change, double-check you
pulled to the path above, not the stale one.

## Action confirmation — close the loop on every external side effect

Per Justin 2026-05-07: **every user-driven action with an external side
effect must surface real delivery confirmation, not just "we sent the
request."** Optimistic-success UI hides real-world failures and erodes
trust in the system.

The 2026-05-07 RVM testing made this painful: Slybroadcast accepted every
drop with a 200 OK, our UI claimed "✅ Voicemail dropped" — but the actual
delivery succeeded only when the recipient's carrier supported direct VM
deposit. For most major US carriers post-2022 FCC ruling, deposit fails
and the call falls through as a regular ring. We were lying to the user.

### Required pattern

When building any feature that talks to a provider that supports delivery
callbacks (Slybroadcast, Twilio, Resend, Stripe, DocuSign, etc.):

1. **Initial action** records optimistic status (e.g. `sms_queued`,
   `rvm_sent`, `email_queued`). This means "we handed it to the provider"
   — NOT "the recipient got it."
2. **Wire the provider's webhook / callback** on the same PR. Don't
   defer it. If we ship the action without the callback, we ship a lie.
   - Slybroadcast: `c_dispo_url` parameter → `slybroadcast-callback` EF
   - Twilio SMS: `StatusCallback` URL → `twilio-status` EF
   - Twilio Voice: `StatusCallback` URL → `twilio-voice-status` EF
   - Resend: webhook events (`email.delivered`, `email.bounced`)
   - DocuSign: Connect / EventNotification → `docusign-status` EF
3. **Update the row** to a terminal status: `delivered` / `undeliverable`
   / `bounced` / `failed`. Surface a `error_message` / `status_reason`
   that explains the outcome in plain English.
4. **The UI shows the real state** — never just "we tried." Each
   terminal status gets distinct visual treatment (color, icon, label):
   - delivered → green, "✓ delivered"
   - awaiting → orange, "awaiting confirmation"
   - undeliverable → amber, "undeliverable" + reason
   - failed → red, "failed" + retry path
5. **Auth the webhook**. Provider callbacks hit a public URL. Verify a
   shared secret (query param) or HMAC signature before trusting the
   payload — otherwise anyone can forge "delivered."

### Existing implementations to copy from

- `supabase/functions/slybroadcast-callback/` — query-param shared-secret
  auth, GET-or-POST tolerant, classifies provider disposition strings
  into our canonical status. Updates `messages_outbound` in place.
- `supabase/functions/twilio-status/` — Twilio status callback handler.
- `supabase/functions/twilio-voice-status/` — Voice call status.
- `supabase/functions/docusign-status/` — DocuSign Connect events.

### Anti-patterns

- Showing "✅ Sent" when the provider only ACK'd the request → users
  trust this as ground truth, then get burned when delivery silently fails
- Storing only the immediate response — losing the actual outcome means
  the audit trail is wrong + the dashboard is wrong forever
- Accepting webhooks without auth → trivial to forge "delivered" status

## QA protocol — mandatory before declaring work done

**Before saying a feature is ready, always browser-test the core user flows end to end.**
Use the Claude-in-Chrome MCP tools to QA directly in the browser, not just by reading code.

### Outreach / AI draft flow checklist
1. Today view → AUTOMATIONS section shows deal with "Intro draft ready" and "Review →"
2. Click Review → navigates to correct deal's Comms tab with AI Draft panel
3. Draft panel shows: from/to numbers, clean draft text (no em dashes, no JSON garbage), char count, coach field, Regenerate + Edit + Send + Skip buttons
4. **Regenerate with coach note** → spinner shows while generating, then clears and new draft appears (within ~15s). Spinner must NOT stay stuck after success.
5. **Edit → type changes → Save Draft** → edit mode exits, new text persists, no SMS sent
6. **Send** → AI Draft panel disappears, message appears in the thread as a sent bubble
7. **Back to Today view** → AUTOMATIONS section is gone (or no longer shows that deal)

### General QA rules
- Always test the happy path + at least one "make another" variation (regenerate, re-edit)
- Check char counter updates live as you type in edit mode
- Verify split warning appears for messages > 160 chars ("will send as N texts")
- If a spinner appears, wait for it to resolve — never declare pass while something is still loading
- Check browser console for JS errors after every interaction (`read_console_messages` with `onlyErrors: true`)

### Common bugs to watch for
- `isGen` / `isSend` local state stuck `true` after success (missing `finally` reset) → spinner never clears
- Realtime subscription not firing on edge-function DB writes → use polling fallback (3s interval already in place)
- `firedRef` Set needed to prevent double-calling edge functions across React re-renders

## Pre-ship verification — rules from real shipped-then-rebroke bugs

Hard rules learned from regressions. **Add to this list every time we ship
something that breaks in a recognizable pattern.** Boris Cherny's principle:
*"Claude is eerily good at writing rules for itself from its own failures."*
The moment something rebreaks, ask: "what rule would have caught this?" →
append it here.

### Multi-path EF changes — test BOTH gateway branches
**Pattern:** `send-sms` has two code paths (`gateway === 'mac_bridge'` vs
Twilio fallback). A fix on one branch is NOT a fix on the other. Today's
text-splitting bug was shipped twice — first the iMessage path (`#235`,
2026-05-27), then the Twilio path (2026-05-28) because PR #211 had already
made Twilio the default sender on 5/24.

**Rule:** Any change to `send-sms`, `receive-sms`, or any other EF with
explicit `if (gateway === X)` branches must:
1. Identify every branch the change might affect.
2. Reason explicitly about whether each branch needs the same fix.
3. After deploy, send a real test message on each gateway and verify in
   `messages_outbound` that segment count = 1 (or expected value).

Same principle for any EF with a router pattern (channel switching,
provider failover, etc.).

### Surplus disbursement math — verify the line items add to the sale price
**Pattern:** A "no surplus" text to a homeowner is a high-cost error —
if the homeowner later sees the disbursement and learns we wrote them
off prematurely, the relationship is gone. On 2026-05-28 a draft "no
surplus" text was almost sent for Joseph Beitko (case 2025-CV-00945)
when in fact line (k) of the Confirmation Entry was a blank balance
holding ~$27,944 pending further order.

**Rule:** Before writing a "no surplus" text to a homeowner:
1. Add up every itemized distribution (a-j in a standard Ohio Confirmation
   Entry).
2. Compute `balance = sale_price - sum(distributions)`.
3. If `balance > 0`, the surplus exists. Use the `/surplus-math` skill to
   formalize this — never eyeball it.
4. A blank line (k) in the proposed entry means the court has not yet
   filled in the balance — it does NOT mean the balance is zero.
5. If we believe supplemental claims will consume the balance, NAME the
   specific claim (post-judgment interest amount, attorney-fee motion, etc.)
   rather than handwaving "Lakeview will probably take it." If we can't
   name it, the homeowner has surplus.

### Post-deploy verification — committed ≠ live
**Pattern:** "I committed the fix" is not "the fix is running in prod."
Today's send-sms regression: we declared #235 done because the commit
landed, then it took Nathan hitting the bug again to learn the deploy
either didn't take, didn't cover the active code path, or shipped to a
function path that wasn't actually being called.

**Rule:** After any EF deploy (Justin's or ours), verify the deployed
behavior — not just the commit — before declaring done:
1. Trigger the EF with a real test scenario (or query for the most recent
   real invocation).
2. Confirm the output matches the expected behavior.
3. If the deploy is gated on a remote owner (Justin deploys, we wait),
   the "done" flag waits with it. **The PR is "ready for deploy," not
   "shipped."**

Use the `verify-deploy` skill (`.claude/skills/verify-deploy/`) which
encodes this for known EFs.

### Article-derived: high-leverage habits to compound
From the 2026-05-28 Claude Code Mastery review:

- **Default to plan mode** for any change touching > 1 file. `Shift+Tab`
  twice. Edit the plan with `Ctrl+G` before letting code generation start.
- **Delegate, don't pair-program.** Cat Wu (Anthropic): *"The model performs
  best if you treat it like an engineer you're delegating to."* For
  well-bounded tasks (draft this text, ship this migration), set a `/goal`
  and verify the output — don't narrate each step.
- **Use `/voice` for prompting.** ~3× faster than typing per the article's
  author; prompts get longer + more detailed.
- **Worktrees as default for parallel sessions.** Right now Justin's session
  and Nathan's session both push to `src/app.jsx` on `main` and constantly
  rebase. `claude --worktree <feature>` isolates per stream. The Stop hook
  already handles per-worktree subsections in `WORKING_ON.md`.
- **`/code-review` before push to main** — when the plugin is installed,
  run it on any change touching DCC UI, EFs, or migrations.

## Inventory & status outputs — verify before rendering

Anytime a session is asked to produce a "what we have" / "what we use" /
"what's live" deliverable (third-party tool inventory, edge-function list,
table list, table-of-contents, status report, pitch material, PDF, deck),
follow this protocol — it exists because we shipped a wrong inventory
2026-05-19 by trusting grep over the operator.

1. **Fetch latest first.** Run `git fetch --all` and confirm the working
   branch is current with `origin/main` *before* doing the inventory.
   Otherwise you'll describe yesterday's codebase. The 2026-05-19 miss was
   100% this — Fish Audio + Slybroadcast had landed on main but weren't in
   the working tree at scan time.

2. **Code-in-repo ≠ in use.** Dead code lingers in the repo after a feature
   is retired (the `quo-webhook` edge function was sitting unused for
   weeks). Treat the user as the source of truth for what's live.
   Presence in `supabase/functions/` proves the file exists, not that it's
   wired up. Cross-check by:
   - asking the user explicitly for anything ambiguous
   - reading `WORKING_ON.md` and recent `session_archives/` for "we retired X"
   - searching commit messages: `git log --all --oneline | grep -i <topic>`

3. **Draft in chat before rendering to a file.** If the deliverable is
   becoming a PDF / slide deck / standalone doc, paste the draft content
   into the chat first, let the user red-pen it, *then* render. Re-rendering
   a PDF takes 30 seconds; the user catching errors at the chat stage
   is dramatically cheaper than catching them after they've forwarded the
   wrong artifact to a partner.

4. **State your sources at the bottom.** End any inventory with a one-line
   note: "Compiled from grep of `supabase/functions/`, `src/app.jsx`,
   and the last 30 days of git log. Operator should confirm before
   sharing externally." This signals confidence level without overpromising.

## Context preservation — fighting session rot

Claude Code sessions corrupt. Context windows fill up. This section explains how to keep
knowledge in the repo so any new session (or human) can pick up where the last one left off.

### The system

| File | What it captures | When to update |
|---|---|---|
| `CLAUDE.md` (this file) | Architecture, schema, conventions, gotchas | When something fundamentally changes |
| `WORKING_ON.md` | What each session is actively doing right now | Every session start + end |
| `TRANSFER_TO_NEW_CLAUDE_CODE.md` | Full business + technical deep-dive | Refresh when starting a new Claude Code project |
| `.github/PULL_REQUEST_TEMPLATE.md` | Per-PR: what changed, why, DB changes, test steps | Auto-populated when opening a PR |

### PR template (mandatory for non-trivial work)

Every PR that touches DB, Edge Functions, or significant UI should fill out
`.github/PULL_REQUEST_TEMPLATE.md`. It lives in the commit history forever —
even if sessions die, the context is preserved in GitHub PRs.

### If your session is approaching the context limit

Before the context fills:
1. Write a `WORKING_ON.md` entry describing exactly what you were doing, what files
   you touched, what was working, and what was left to do.
2. Commit and push everything — even WIP. A partial commit with a good message is
   better than losing work in a dead session.
3. If mid-feature: push to a branch (not main), describe the branch state in `WORKING_ON.md`.

### The TRANSFER doc

`TRANSFER_TO_NEW_CLAUDE_CODE.md` is the "day 1 briefing" for any new Claude Code session.
Nathan refreshes it when starting a new project. You can read it cold and understand the whole
business in ~5 minutes. Keep it honest — stale context is worse than no context.

## When asking an AI to change this

Give it this file plus the specific task. Good prompts:
- "Add a 'closing date' field to flip deals — store in `meta`, show on the card and detail view."
- "The tasks tab should group by 'done' vs 'open' with the open ones on top."
- "Add a new surplus status 'claim-filed' between 'filed' and 'probate'."

Bad prompts (too vague):
- "Make it better"
- "Add analytics"

Point the AI at `index.html` and this file. It has enough context to make changes without breaking things.
