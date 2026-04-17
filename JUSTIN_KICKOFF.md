# Justin — DCC Kickoff

**From**: Nathan
**To**: Justin (`justin@fundlocators.com`)
**Purpose**: Get you contributing to the Deal Command Center alongside Claude Code, and unblock two Supabase items that only you can do (you own the Supabase project).

Read this doc top-to-bottom once. It's designed to take ~15 minutes, and by the end you'll have DCC running locally, a commit ability, and the two immediate blockers cleared. Everything deeper lives in `ONBOARDING.md` — this doc is the short-path kickoff.

---

## 1. What DCC is (one paragraph)

DCC (Deal Command Center) is the internal operations app for FundLocators. It tracks two kinds of deals — real-estate flips and surplus-fund recovery cases — through their full lifecycle (lead → filed → recovered/closed). It is a **single-file React app** (`index.html`) served from **GitHub Pages** and backed by **Supabase** for auth, Postgres, and file storage. No build step, no bundler, no framework install. You edit `index.html` directly, push to `main`, and GitHub Pages redeploys within about 60 seconds.

Live URL: **https://thelocatoroffunds.github.io/deal-command-center/**
Repo: **https://github.com/TheLocatorOfFunds/deal-command-center**
Supabase project: **`fmrtiaszjfoaeghboycn`**

---

## 2. Two things only you can do right now

These are blocking me because I'm not a member of the Supabase project — only you are. Both should take under 5 minutes.

### 2.1 Create the `deal-docs` storage bucket

DCC's Documents tab is erroring out with "Bucket not found" on every deal because the Supabase storage bucket the code expects (`deal-docs`) was never created.

1. Go to **https://supabase.com/dashboard/project/fmrtiaszjfoaeghboycn/storage/buckets**
2. Click **New bucket**
3. **Name**: `deal-docs` — exact, lowercase, hyphen, no spaces.
4. **Public bucket**: **leave UNCHECKED.** The app uses signed URLs (`createSignedUrl`) which require a private bucket.
5. Leave file-size / MIME limits empty. Defaults are fine.
6. Click **Create bucket**.

### 2.2 Create RLS policies on the bucket

Open the SQL editor: **https://supabase.com/dashboard/project/fmrtiaszjfoaeghboycn/sql/new**

Paste this and click **Run**:

```sql
-- Allow any authenticated user to read, upload, update, and delete
-- objects inside the deal-docs bucket. Matches the rest of the app's
-- "small trusted team" RLS model.

create policy "auth_select_deal_docs" on storage.objects
  for select to authenticated
  using (bucket_id = 'deal-docs');

create policy "auth_insert_deal_docs" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'deal-docs');

create policy "auth_update_deal_docs" on storage.objects
  for update to authenticated
  using (bucket_id = 'deal-docs');

create policy "auth_delete_deal_docs" on storage.objects
  for delete to authenticated
  using (bucket_id = 'deal-docs');
```

If any of those policies already exist you'll get an error — just delete that block from the SQL and run the rest.

### 2.3 Add Nathan as a Supabase team member (please)

Right now I can't open the Supabase dashboard for this project because I'm not on the team — only you are. When things like the bucket issue above come up, I'm fully blocked until you're available. Please add me:

1. Go to **https://supabase.com/dashboard/project/fmrtiaszjfoaeghboycn/settings/team**
2. Click **Invite**
3. Email: `nathan@fundlocators.com`
4. Role: **Owner** (or Admin — whatever gives me full dashboard access). We can tighten this later; for now I need parity with you so ops items don't block.

That's the unblock set. When you're done with 2.1, 2.2, and 2.3, reply to me and the Documents tab will work and we'll both have dashboard access.

---

## 3. Getting Claude Code running on DCC

This is the same flow the rest of the team uses. Full version: read `ONBOARDING.md` in this repo (it's the canonical source). Short version:

### Prereqs
- **macOS or Windows 11** with a terminal.
- **git** installed.
- **Node.js 20+** (if you don't already have it — `brew install node` or the official installer).
- **Claude Code** — https://claude.com/claude-code. Sign in with your Anthropic / Claude account.
- **GitHub CLI** — optional but handy: `brew install gh`.

### Step 1: Clone the repo

```bash
cd ~/Documents  # or wherever you want the repo to live
git clone https://github.com/TheLocatorOfFunds/deal-command-center.git
cd deal-command-center
```

### Step 2: Create a GitHub Personal Access Token (PAT)

You'll use this token to let Claude Code push commits on your behalf.

1. Go to **https://github.com/settings/tokens** → **Generate new token (classic)**.
2. **Note**: `dcc-justin-<machine>-2026-04` — e.g. `dcc-justin-mbp-2026-04`. We use the naming convention `<project>-<person>-<machine>-<yyyy-mm>` so tokens are traceable and easy to rotate.
3. **Expiration**: 90 days (or whatever you're comfortable with — shorter is better).
4. **Scopes**: check **`repo`** only. Nothing else.
5. Click **Generate token**. Copy the `ghp_...` value — you will only see it once.
6. Store it in your password manager (1Password / macOS Keychain / Bitwarden).

When Claude Code needs to push, paste the token once per session. Do not paste it into `index.html` or into any committed file. **Ever.** If you accidentally commit a token, revoke it immediately at https://github.com/settings/tokens and generate a new one.

### Step 3: Launch Claude Code

```bash
cd ~/Documents/deal-command-center   # inside the repo
claude
```

The first session will ask you to authenticate. Once you're in, Claude Code reads `CLAUDE.md` (the repo's "north star" doc) automatically, so the agent already knows the schema, conventions, and guardrails before you say anything.

Quick first-task sanity check:
> "Read CLAUDE.md and ROADMAP.md. Then show me the high-level architecture in 4 bullets."

If that works cleanly, you're set up.

### Step 4: Your first change

Pick something tiny for the first PR — renaming a label, fixing a typo in an empty-state, adjusting a color — so you get through the full loop (edit → commit → push → watch it deploy → see it live). `ONBOARDING.md` has a "first-change walkthrough" section that covers this end-to-end.

---

## 4. How DCC deploys (important mental model)

There is **no staging environment.** The `main` branch on GitHub IS production. A push to `main` redeploys the live app within ~60 seconds via GitHub Pages.

Consequences:
- Never push broken code to `main`. Claude Code will test locally before pushing — trust that step.
- Small, frequent commits are better than big ones. Easier to revert if something breaks.
- If something DOES break in prod, the fix is either (a) a new commit rolling it back, or (b) `git revert <sha> && git push`. Don't force-push `main` — it will rewrite history others depend on.

Monitor your deploys at https://github.com/TheLocatorOfFunds/deal-command-center/actions — each push shows up as a Pages build. If it turns red, read the log; if it stays red, ping me.

---

## 5. The repo at a glance

```
deal-command-center/
├── index.html                               ← THE APP. Single file. React + Babel Standalone + Supabase client.
├── README.md                                ← Top-level project readme.
├── CLAUDE.md                                ← The "north star" — schema, conventions, guardrails. Claude Code reads this automatically.
├── ONBOARDING.md                            ← Full contributor onboarding. Read after this kickoff.
├── ROADMAP.md                               ← Feature ideas + expansion thinking for DCC itself.
├── REFUNDLOCATORS_CONTEXT.md                ← Tactical brief on the refundlocators.com product.
├── REFUNDLOCATORS_VISION.md                 ← Strategic brief on the refundlocators.com product ("think like Elon Musk").
├── HANDOFF_FROM_DCC_TO_REFUNDLOCATORS.md    ← Integration contract between refundlocators and DCC.
└── JUSTIN_KICKOFF.md                        ← You are here.
```

`index.html` is ~2500 lines of React. Function components, inline styles, Supabase calls. If you've done React before, it reads cleanly. Look for region comments like `// ─── Surplus Overview ───` — they segment the file by feature.

---

## 6. Things to know that will save you an hour

- **Magic-link auth only.** No passwords in the app. If you're testing locally and sign-in fails, check your spam folder.
- **RLS is enforced.** Every Supabase table (`deals`, `expenses`, `tasks`, `vendors`, `deal_notes`, `activity`, `documents`) has row-level security policies tied to the authenticated user. The app will silently return empty arrays if policies are wrong — not errors. If queries return nothing when they shouldn't, check RLS before debugging the query.
- **The `meta` jsonb column is a feature, not a bug.** When in doubt, add new per-deal fields to `deals.meta` rather than creating new columns. Cheaper, faster, no migration. The schema says top-level columns only for things we query/filter on heavily (`status`, `type`, `assigned_to`, `closed_at`, `actual_net`). Everything else goes in `meta`.
- **The anon key is public.** It's baked into `index.html` and that's fine — the anon key is designed to be public; RLS is what enforces security. The **service_role** key is different: it bypasses RLS and must NEVER appear in `index.html` or any public repo. If a feature needs service_role (e.g., a webhook writing deals), it runs server-side, not in the browser.
- **There is no test suite.** Yet. Sanity-test by loading `index.html` in a browser and clicking through. Roadmap item.
- **No formatter in CI.** Match the style of the surrounding code. When in doubt, let Claude Code handle the edit.

---

## 7. Communication / workflow

- **Commits**: small, descriptive, imperative (`Fix closed-card date fallback` not `fixes and cleanup`). Co-author attribution for Claude is fine:
  ```
  Co-Authored-By: Claude <noreply@anthropic.com>
  ```
- **Breaking changes / DB changes**: tell me BEFORE pushing. DB-schema changes can affect the live app immediately.
- **Questions**: text me. Or if you want durable context, drop a note in CLAUDE.md under a "Open questions" section so the next Claude session sees it.
- **If you find bugs while reading code**: don't silently patch — tell me first. Some "bugs" are intentional (data-model quirks, legacy deals). Context first, fix second.

---

## 8. The bigger picture

FundLocators is evolving from a cold-call sales-floor business to a three-brand ecosystem:

- **defenderha.com** — deal activation (existing)
- **fundlocators.com** — post-foreclosure B2B / existing ops (existing)
- **refundlocators.com** — new AI-native consumer surplus-search product (in development)

DCC is the connective tissue — the operational system of record — for all three. Signed engagements, deal status, expenses, documents, and activity all flow into DCC regardless of which brand originated the lead. If you're going to touch DCC thoughtfully, it helps to understand where it's headed. Read `ROADMAP.md` and `REFUNDLOCATORS_VISION.md` when you have 20 minutes.

Welcome in. Once 2.1, 2.2, and 2.3 are done, we can both move much faster.

— Nathan

---

## Appendix: your first five tasks after the blockers

Once the Supabase items are cleared and you're set up with Claude Code, here are five well-scoped tickets from `ROADMAP.md` you could pick up to get familiar with the code:

1. **Pipeline forecasting tile** — a small dashboard stat predicting quarterly revenue based on active-deal stages.
2. **Lead source ROI** — per-source close rate and avg net profit, surfaced in a new Analytics tab.
3. **Vendor performance card** — which vendors show up across the most deals, with avg spend.
4. **Task templates** — pre-built task lists by deal type (surplus vs flip) so new deals spin up with the right checklist.
5. **CSV import** — bulk-add deals from a spreadsheet, the inverse of the existing CSV export.

All five are self-contained (no schema changes required) and touch different parts of the codebase, so any one of them is a good orientation exercise. Pick whichever feels most useful to you.
