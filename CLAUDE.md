# Deal Command Center — AI Collaborator Primer

This repo is a lead/deal tracker for **RefundLocators** (flips + surplus fund cases). Read this file before making changes — it has the stuff that isn't obvious from reading the code.

## Architecture at a glance

- **Source**: React JSX in `src/app.jsx` (~12,640 lines). Pre-compiled by **esbuild** to `app.js` (~483KB minified) via `npm run build`. **Edit `src/app.jsx`, NOT `index.html`.**
- **Shell**: `index.html` is now a 12KB shell that loads React + ReactDOM + supabase-js from CDN, then `<script src="app.js" defer></script>`.
- **Why the build step**: prior to 2026-04-26, JSX was inline in `index.html` and transpiled at runtime by Babel-Standalone. The file grew past Babel's 500KB deopt threshold and cold-loads were 10-15 sec. esbuild eliminates Babel-in-browser entirely; cold-load is sub-second.
- **Build workflow**: edit `src/app.jsx` → `npm run build` (~30ms) → `git add src/app.jsx app.js index.html` → commit + push. **Always commit `app.js` along with source — GitHub Pages serves it directly.**
- **Build tooling**: `package.json` + `build.js` + `node_modules` (gitignored). Run `npm install` once after cloning.
- **Backend**: Supabase project `rcfaashkfpurkvtmsmeb` — Postgres + Auth + Realtime.
- **Hosting**: GitHub Pages on `main` branch root. Any commit to `main` rebuilds in ~30s. URL: https://thelocatoroffunds.github.io/deal-command-center/ (custom domain: app.refundlocators.com).
- **Auth**: Magic-link (`signInWithOtp`). Users auto-create on first sign-in. Profiles auto-populate via `handle_new_user` trigger.

## Credentials

Supabase URL + **publishable** (anon) key are hardcoded near the top of `src/app.jsx`:

```js
const SUPABASE_URL = 'https://rcfaashkfpurkvtmsmeb.supabase.co';
const SUPABASE_KEY = 'sb_publishable_...';
```

This is safe — the publishable key is designed for client-side use. RLS is what actually protects data. **Never** put the service-role key in this file.

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

- **Daily digest**: `public.send_daily_digest()` runs at 12:00 UTC (8am EDT / 7am EST) via pg_cron job `daily-digest-nathan`. Queries stale deals, urgent deadlines, unfiled surplus, bonuses owed, portal activity, monthly metrics — builds an HTML email and sends via Resend. API key stored in Supabase Vault under `resend_api_key`.
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

## Top-level views (nav order, left → right)

1. **📌 Today** — daily dashboard, AutomationsQueue (pending outreach drafts), team activity
2. **🔔 Attention** — reactive: per-deal unread/unacked items + Castle scraper alerts strip + cross-deal deadline alerts strip
3. **🚀 Outreach** — campaign workspace: 4 stats tiles + AutomationsQueue + ReplyInbox (cross-deal inbound SMS unread)
4. **📅 Forecast** — proactive 7-14 day planning: court hearings, statutory deadlines, cadence drips, disbursement watch, stale active deals, sheriff sales
5. **🧭 Pipeline** — kanban view filtered by lead_tier A/B/C, has the **🚀 Queue outreach · N A/B** bulk-queue button on the filter bar
6. **✓ Tasks** — global task list across deals
7. **Active / Flagged / Hygiene / Closed** — deal-list views by status filter
8. **📈 Reports / 📊 Analytics / 🌐 Traffic** — admin-only metrics views (Reports has the per-agent ScraperHealthPanel)

Plus modal entries from the top header: 🔍 search, ⚖ Docket overview, 👥 Contacts, 📚 Library, Team.

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
| Lauren / pgvector AI chat | **Justin** | `lauren_*` tables, pgvector embeddings |
| Phase 3 Library | **Nathan** | Designed — not yet built |
| Phase 4 Financials | **Nathan** | Not yet built |
| **Shared (either can touch)** | Both | `deals`, `vendors`, `tasks`, `expenses`, `activity`, `deal_notes`, `documents`, `contacts`, `contact_deals`, `index.html` shell + nav + shared components |

**When in doubt**: don't write migrations or edit Edge Functions in another owner's domain.
Post a note and wait for the other session to coordinate.

## Co-coding protocol (read every session)

### Session start ritual
```bash
git pull                                    # always — Nathan may have pushed
cat WORKING_ON.md                           # see what the other session is doing
```
Then update `WORKING_ON.md` with what you're about to work on.

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

### Session end ritual
1. Commit everything (including any migration files)
2. Update `WORKING_ON.md` — clear your entry or note what's left
3. Push branch (or merge to `main` if it's stable and tested)

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
All email copy says **RefundLocators**, never FundLocators.
Sender: `RefundLocators <hello@refundlocators.com>` (Resend-verified via DKIM).

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

## Mac Mini (Defender Mini) — SSH access

Claude can SSH directly into the Mac Mini to deploy bridge fixes without any manual steps.

```bash
ssh defender-mini   # resolves to dealcommandcenter@defender-mini.local
```

**After any change to `mac-bridge/bridge.js`**, always run this to deploy:
```bash
ssh defender-mini "cd '/Users/dealcommandcenter/Documents/DealCommand Center/deal-command-center' && git pull && launchctl unload ~/Library/LaunchAgents/com.refundlocators.bridge.plist && launchctl load ~/Library/LaunchAgents/com.refundlocators.bridge.plist && sleep 3 && tail -20 /tmp/dcc-bridge.log"
```

Check bridge logs anytime:
```bash
ssh defender-mini "tail -50 /tmp/dcc-bridge.log"
```

SSH key: `~/.ssh/defender_mini` (ed25519, already authorized on Mac Mini)
Plist: `com.refundlocators.bridge`
Bridge repo path: `/Users/dealcommandcenter/Documents/DealCommand Center/deal-command-center/`

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

## When asking an AI to change this

Give it this file plus the specific task. Good prompts:
- "Add a 'closing date' field to flip deals — store in `meta`, show on the card and detail view."
- "The tasks tab should group by 'done' vs 'open' with the open ones on top."
- "Add a new surplus status 'claim-filed' between 'filed' and 'probate'."

Bad prompts (too vague):
- "Make it better"
- "Add analytics"

Point the AI at `index.html` and this file. It has enough context to make changes without breaking things.
