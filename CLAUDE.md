# Deal Command Center — AI Collaborator Primer

This repo is a lead/deal tracker for **FundLocators** (flips + surplus fund cases). Read this file before making changes — it has the stuff that isn't obvious from reading the code.

## Architecture at a glance

- **One file**: `index.html` is the entire app (~52KB). No build step, no bundler, no package.json.
- **Runtime**: React 18 + Babel Standalone + `@supabase/supabase-js@2`, all loaded from CDN inside the HTML. JSX is transpiled in the browser via `<script type="text/babel">`.
- **Backend**: Supabase project `fmrtiaszjfoaeghboycn` — Postgres + Auth + Realtime.
- **Hosting**: GitHub Pages on `main` branch root. Any commit to `main` rebuilds in ~30s. URL: https://thelocatoroffunds.github.io/deal-command-center/
- **Auth**: Magic-link (`signInWithOtp`). Users auto-create on first sign-in. Profiles auto-populate via `handle_new_user` trigger.

## Credentials

Supabase URL + **publishable** (anon) key are hardcoded near the top of `index.html`:

```js
const SUPABASE_URL = 'https://fmrtiaszjfoaeghboycn.supabase.co';
const SUPABASE_KEY = 'sb_publishable_...';
```

This is safe — the publishable key is designed for client-side use. RLS is what actually protects data. **Never** put the service-role key in this file.

## Database schema

7 tables, all in `public` schema:

| Table | Purpose | Key columns |
|---|---|---|
| `profiles` | 1:1 with `auth.users` | `id` (uuid, FK to auth.users), `name`, `role` |
| `deals` | The core entity | `id` (text PK), `type` ('flip' / 'surplus' / 'wholesale' / 'rental' / 'other'), `status`, `name`, `address`, `meta` (jsonb for flexible per-type fields), `owner_id` |
| `expenses` | Per-deal line items | `deal_id` FK, `category`, `amount`, `date`, `vendor`, `notes` |
| `tasks` | Per-deal todos | `deal_id` FK, `title`, `done`, `assigned_to`, `due_date` |
| `vendors` | Per-deal contractors/contacts | `deal_id` FK, `name`, `role`, `phone`, `email` |
| `deal_notes` | Per-deal markdown | `deal_id` FK (unique), `body` |
| `activity` | Audit log | `deal_id` FK, `user_id`, `action`, `created_at` |

All child tables cascade-delete when the parent deal is deleted.

## RLS model (important — read before tightening)

Every table has RLS enabled with a single permissive policy: **any authenticated user can do anything**. This is the "small trusted team" model.

```sql
create policy auth_all_deals on deals for all to authenticated using (true) with check (true);
```

If/when the team grows (VAs, external contractors), tighten per-table. Common patterns:
- Restrict deletes to `owner_id = auth.uid()`
- Hide `activity` or financial columns from certain roles
- Check `profiles.role` in policy predicates

Don't tighten RLS without also testing that the app still works — the UI assumes it can read/write everything.

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
