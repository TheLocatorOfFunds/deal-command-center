# Deal Command Center — AI Collaborator Primer

This repo is a lead/deal tracker for **FundLocators** (flips + surplus fund cases). Read this file before making changes — it has the stuff that isn't obvious from reading the code.

## Architecture at a glance

- **One file**: `index.html` is the entire app (~52KB). No build step, no bundler, no package.json.
- **Runtime**: React 18 + Babel Standalone + `@supabase/supabase-js@2`, all loaded from CDN inside the HTML. JSX is transpiled in the browser via `<script type="text/babel">`.
- **Backend**: Supabase project `rcfaashkfpurkvtmsmeb` — Postgres + Auth + Realtime.
- **Hosting**: GitHub Pages on `main` branch root. Any commit to `main` rebuilds in ~30s. URL: https://thelocatoroffunds.github.io/deal-command-center/
- **Auth**: Magic-link (`signInWithOtp`). Users auto-create on first sign-in. Profiles auto-populate via `handle_new_user` trigger.

## Credentials

Supabase URL + **publishable** (anon) key are hardcoded near the top of `index.html`:

```js
const SUPABASE_URL = 'https://rcfaashkfpurkvtmsmeb.supabase.co';
const SUPABASE_KEY = 'sb_publishable_...';
```

This is safe — the publishable key is designed for client-side use. RLS is what actually protects data. **Never** put the service-role key in this file.

## Database schema

10 tables, all in `public` schema:

| Table | Purpose | Key columns |
|---|---|---|
| `profiles` | 1:1 with `auth.users` | `id` (uuid, FK to auth.users), `name`, `role` — one of `admin`, `user` (legacy admin), `va`, `attorney`, `client` |
| `deals` | The core entity | `id` (text PK), `type` ('flip' / 'surplus' / 'wholesale' / 'rental' / 'other'), `status`, `name`, `address`, `meta` (jsonb for flexible per-type fields), `owner_id` |
| `expenses` | Per-deal line items | `deal_id` FK, `category`, `amount`, `date`, `vendor`, `notes` |
| `tasks` | Per-deal todos | `deal_id` FK, `title`, `done`, `assigned_to`, `due_date` |
| `vendors` | Per-deal contractors/contacts | `deal_id` FK, `name`, `role`, `phone`, `email` |
| `deal_notes` | Per-deal markdown | `deal_id` FK (unique), `body` |
| `activity` | Audit log | `deal_id` FK, `user_id`, `action`, `created_at` |
| `documents` | Per-deal file metadata | `deal_id` FK, `name`, `path`, `size`, `uploaded_by` — actual files in `deal-docs` storage bucket |
| `client_access` | Links auth users to deals for the Client Portal | `user_id` (nullable until client signs up), `deal_id`, `email`, `enabled`, `last_seen_at`, `prefs` jsonb |
| `attorney_assignments` | Links auth users to deals for Attorney scoped access | same shape as `client_access` |

All child tables cascade-delete when the parent deal is deleted.

## RLS model (important — read before modifying)

Four-tier model driven by `profiles.role`:

- **Admin** (`role IN ('admin', 'user')`, Nathan/Justin): full access via `admin_all_*` policies on every table.
- **Virtual Assistant** (`role = 'va'`): access to deals, tasks, vendors, activity, deal_notes, documents, client_access. **No access to `expenses`.** UI also hides financial fields in `deals.meta` (trust-based for jsonb keys).
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
2. Edit `index.html`
3. Open the file directly in a browser (`file://...`) to test — auth works, Supabase calls work. No dev server needed.
4. `git commit -am "..."` and `git push`
5. Wait ~30s, refresh https://thelocatoroffunds.github.io/deal-command-center/

No staging environment. Commits to `main` go live. Coordinate with the team before big changes.

## Common change recipes

### Add a new field to deals
1. In Supabase SQL editor: `alter table deals add column foo text;` — or add inside `meta` jsonb to avoid migrations.
2. In `index.html`, add the field to `NewDealModal`, `DealDetail`, and (if it should show on the card) `DealCard` / `SurplusCard`.

### Add a new deal type (e.g. "wholesale")
1. Add the type to `DEAL_STATUSES` (new array of stages).
2. Add status colors to `STATUS_COLORS`.
3. Add a case in `DealList` to render a section for it.
4. Add a card component if the layout should differ from `DealCard`.

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

## Team

- **Nathan** (nathan@fundlocators.com) — owner
- **Justin** (justin@fundlocators.com) — co-founder / developer

## When asking an AI to change this

Give it this file plus the specific task. Good prompts:
- "Add a 'closing date' field to flip deals — store in `meta`, show on the card and detail view."
- "The tasks tab should group by 'done' vs 'open' with the open ones on top."
- "Add a new surplus status 'claim-filed' between 'filed' and 'probate'."

Bad prompts (too vague):
- "Make it better"
- "Add analytics"

Point the AI at `index.html` and this file. It has enough context to make changes without breaking things.
