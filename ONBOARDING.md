# Onboarding: Making Changes to the Deal Command Center with Claude Code

Welcome. This guide gets you from zero to pushing updates to the RefundLocators Deal Command Center using Claude Code, the same setup Nathan uses.

By the end of this doc you'll be able to:

- Open the codebase in Claude Code and have it understand the project
- Ask Claude to make changes in plain English
- Commit and push those changes to GitHub
- See your changes live on the production dashboard ~30 seconds later
- Make database schema changes through Supabase when needed

---

## 1. What this app is (the 60-second version)

**URL**: https://thelocatoroffunds.github.io/deal-command-center/

A single-page lead and deal tracker for RefundLocators — flips and surplus fund cases. Nathan, Eric, Inaam and others sign in with magic links and collaborate on deals in real time.

**Architecture**:
- One HTML file: `index.html` (~90 KB, ~1400 lines). No build step, no bundler.
- React 18 + Babel Standalone loaded from CDN, transpiled in the browser.
- Backend is Supabase (Postgres + Auth + Realtime).
- Hosted on GitHub Pages — any commit to `main` rebuilds the live site in about 30 seconds.

**You do not need to install Node, run `npm`, or spin up a dev server.** You edit the file, you commit, you push, it deploys. The entire loop is Git.

The authoritative technical reference is `CLAUDE.md` in the repo root — read it once before making changes. It documents the schema, RLS model, deployment flow, and common change recipes. Claude Code loads it automatically when you open the repo.

---

## 2. Prerequisites — what you need before you start

### Accounts you need

| Account | Why | How to get it |
|---|---|---|
| GitHub account | To clone the repo and push commits | https://github.com/join |
| GitHub collaborator access to `TheLocatorOfFunds/deal-command-center` | So you can push to `main` | **Ask Nathan to add you** — he goes to the repo → Settings → Access → Add people → your GitHub username or email |
| Supabase project member for `fmrtiaszjfoaeghboycn` | Only needed for schema changes (new columns, new tables, RLS policy edits) | **Ask Nathan to invite you** — he goes to supabase.com/dashboard → project → Settings → Team → Invite → your email |
| A Deal Command Center login | To test your changes end-to-end | Already works — just visit the URL, enter your email, click the magic link |

### Software you need

1. **Claude Code** — https://claude.com/claude-code
   Install it, sign in with your Claude subscription.
2. **Git** — usually pre-installed on macOS. Check with `git --version`. If missing, install via `xcode-select --install`.
3. **A GitHub Personal Access Token (PAT)** — you'll create this in step 3 below.

That's it. No Node, no npm, no Docker.

---

## 3. Create a GitHub Personal Access Token (PAT)

Claude Code needs a PAT to push commits on your behalf. This replaces your GitHub password for Git operations (GitHub doesn't accept passwords anymore).

1. Go to https://github.com/settings/tokens
2. Click **Generate new token** → **Generate new token (classic)**
3. Settings:
   - **Note**: `dcc-<yourname>-<machine>-2026-04` (e.g. `dcc-justin-macbook-2026-04`)
   - **Expiration**: 90 days is a reasonable default. For a one-time push, 7 days.
   - **Scopes**: Check **`repo`** only. Don't check anything else.
4. Click **Generate token**
5. **Copy the token immediately** — it starts with `ghp_...`. GitHub only shows it once.

### Naming convention

Follow this pattern so your token list stays organized:

```
<project>-<person>-<machine>-<yyyy-mm>
```

Examples:
- `dcc-justin-macbook-2026-04`
- `dcc-justin-desktop-2026-04`
- `dcc-github-actions-2026-04` (if we ever add CI)

### Rules of thumb

- **One PAT per use case.** Don't reuse across machines. If one leaks, you only revoke that one.
- **Short-lived.** For a one-off push, 7 days. For daily dev, 90 days.
- **Minimum scopes.** `repo` is enough. Don't check `admin:*` or `delete_repo`.
- **Store it in your keychain, not a text file.** When Git prompts you, macOS caches it in the Keychain automatically. You won't need to paste it again on that machine.
- **Revoke unused tokens.** Go back to the settings page and delete anything you're no longer using.

---

## 4. Clone the repo and launch Claude Code

Open Terminal and run:

```bash
cd ~/Documents
git clone https://github.com/TheLocatorOfFunds/deal-command-center.git
cd deal-command-center
claude
```

On the first push, Git will prompt for your GitHub username and password:

- **Username**: your GitHub username
- **Password**: paste the PAT from step 3 (not your actual GitHub password)

macOS caches this in Keychain. You won't be prompted again on that machine.

### What Claude Code does when it starts

- Reads `CLAUDE.md` in the repo root — this is the project primer. It explains the architecture, schema, RLS model, and deployment flow.
- Reads `ONBOARDING.md` (this file) if you reference it.
- Is now ready to edit `index.html` and push changes.

---

## 5. Making your first change

### The workflow

1. Ask Claude in plain English: *"Add a 'priority' badge to flip deal cards — high/medium/low, stored in `meta.priority`."*
2. Claude reads the relevant parts of `index.html`, makes the edit, and shows you the diff.
3. You review, confirm.
4. Claude commits with a descriptive message and pushes to `main`.
5. Wait ~30 seconds, refresh https://thelocatoroffunds.github.io/deal-command-center/ — your change is live.

### Testing locally before pushing (optional)

Because there's no build step, you can open `index.html` directly in your browser:

```bash
open index.html
```

It will load with a `file://` URL. Auth works (Supabase doesn't care about origin for magic links). Realtime works. You can test as if it were production before you push.

### Good prompts (from `CLAUDE.md`)

- "Add a 'closing date' field to flip deals — store in `meta`, show on the card and detail view."
- "The tasks tab should group by 'done' vs 'open' with the open ones on top."
- "Add a new surplus status 'claim-filed' between 'filed' and 'probate'."
- "Make the mobile layout stack the portfolio stats in a single column."

### Bad prompts (too vague — Claude will ask for clarification)

- "Make it better"
- "Add analytics"
- "Clean up the UI"

The rule: tell Claude **what field/feature**, **where it goes**, and **how it should look or behave**.

---

## 6. Common change recipes (what Claude can do for you)

### Add a new field to deals

1. Ask Claude: *"Add a `priority` field (high/medium/low) to flip deals — store in `meta.priority`, show on DealCard and DealDetail."*
2. Claude edits `NewDealModal`, `DealDetail`, `DealCard` in `index.html`.
3. No SQL needed — `meta` is a jsonb column so schema-less fields go there.

### Add a new deal type (e.g. "rental")

1. Ask Claude: *"Add a new deal type 'rental' with stages: prospecting, leased, stabilized, sold."*
2. Claude updates `DEAL_STATUSES`, `STATUS_COLORS`, and adds a rendering branch in `DealList`.

### Add a new user to the assignment dropdown

1. Ask Claude: *"Add Sarah to the assignment dropdown — email sarah@refundlocators.com."*
2. Claude updates the `teamMembers` array.
3. Sarah still needs to sign in separately to get a `profiles` row.

### Invite a VA with limited access

1. Share the URL with them — they sign in with magic link, their profile auto-creates.
2. In Supabase SQL editor, run `update profiles set role = 'va' where id = '...';`
3. Ask Claude to *"Tighten RLS policies so users with role 'va' can't see the activity log or delete deals."*
4. Claude writes the SQL and walks you through running it in Supabase.

### Change a status name

Don't. Or if you must, coordinate with the team first — status strings are referenced in `STATUS_COLORS`, seed data, and existing rows. Claude will handle all three, but existing rows in the database keep the old value unless you migrate them.

---

## 7. Database / schema changes

Most UI changes don't touch the database. But sometimes you need a new column or a new table.

### When you need SQL

- Adding a first-class column (not via `meta`)
- Creating a new table
- Changing RLS policies
- Fixing bad data

### How to run SQL

1. Ask Claude to draft the SQL for your change.
2. Go to https://supabase.com/dashboard/project/fmrtiaszjfoaeghboycn/sql/new
3. Paste the SQL and run it.
4. Screenshot or copy the output back to Claude so it can verify.

### What you should **never** do

- Never paste the Supabase **service-role key** into `index.html` or any other file. The publishable key in the file is safe for client-side use; the service-role key bypasses RLS and would give anyone who views the page full database access.
- Never disable RLS on a table. If you need to loosen a policy, loosen it explicitly rather than turning RLS off.
- Never `delete from` without a `where` clause. Ask Claude to write the delete statement — it will include a safety check.

---

## 8. Deployment, rollback, and safety

### Deployment

Every push to `main` triggers a GitHub Pages rebuild. It takes about 30 seconds. No manual deploy, no staging.

### Rollback

If a push breaks production:

```bash
cd ~/Documents/deal-command-center
git log --oneline -5          # find the last good commit
git revert HEAD                # creates a new commit that undoes the last one
git push
```

Or ask Claude to do it: *"Revert the last commit — the 'add analytics' one — and push."*

### No staging

There is no staging environment. Pushes are live. For anything risky:

1. Test locally in your browser first (`open index.html`).
2. Coordinate with the team in Slack before pushing.
3. Push during a quiet hour if you can.

### Real-time = real users see it

The app is realtime. If you deploy a broken version while Nathan is editing a deal, his session could error out. Push during downtime when possible.

---

## 9. Coordinating with the team

- **Nathan** (nathan@refundlocators.com) — owner, makes most of the changes
- **Justin** (justin@refundlocators.com) — co-founder / developer
- **Eric, Inaam** — team members, may be assigned deals

Before making anything bigger than a small UI tweak or a new field, message the team. Things worth coordinating:

- Adding or renaming a deal status
- Changes to how P&L is calculated
- Changes to the data model that affect existing deals
- Anything touching RLS or auth

For small stuff (fix a typo, add a badge, tweak a color), just push.

---

## 10. Troubleshooting

### `git push` asks for credentials again

The Keychain cache expired or got cleared. Create a fresh PAT (step 3) and paste it when prompted. macOS will re-cache it.

### `git push` rejects with "non-fast-forward"

Someone else pushed while you were working. Pull first:

```bash
git pull --rebase
git push
```

If there are conflicts, ask Claude to help resolve them — share the conflicted file contents.

### The site didn't update after pushing

- Check https://github.com/TheLocatorOfFunds/deal-command-center/actions — you should see a "pages build and deployment" workflow running.
- If it's green and the site still shows the old version, hard-refresh (`Cmd+Shift+R`) to bust the browser cache.
- If the workflow failed, click into it to see the error. Usually a typo in `index.html` that broke the HTML.

### Realtime stopped syncing between users

Check the browser console (`Cmd+Option+J`) on both sessions. If you see Supabase websocket errors, it's probably a transient network issue — refresh both sessions. If it persists, check the Supabase dashboard for any service incidents.

### Claude says "I can't push — no TTY for credentials"

Your Keychain doesn't have a PAT cached yet. In Terminal, run `git push` manually once so it prompts you. Paste your PAT. Then ask Claude to try again.

### A magic link email didn't arrive

- Check spam.
- Check Supabase Dashboard → Auth → Users to see if the user exists.
- The default SMTP provider is rate-limited. If this happens a lot, we may need to configure a custom SMTP.

---

## 11. Security hygiene

### Never paste into chat

- Passwords of any kind
- The Supabase **service-role** key (starts with `eyJ...` and is very long; it's in Supabase Dashboard → Settings → API, labeled "service_role")
- Private customer PII (SSNs, bank accounts)

### Safe to share

- The Supabase **anon / publishable** key (already in `index.html`)
- Your GitHub username
- Repo URLs
- Deal names and addresses (they're already in the app for authenticated users)

### PAT hygiene

- Rotate every 90 days.
- Revoke immediately if you suspect a leak (https://github.com/settings/tokens → Delete).
- Don't commit PATs to the repo. Ever. If you do, revoke immediately and force-push a clean history.

---

## 12. Useful links

| What | URL |
|---|---|
| Live app | https://thelocatoroffunds.github.io/deal-command-center/ |
| GitHub repo | https://github.com/TheLocatorOfFunds/deal-command-center |
| GitHub Actions (deploys) | https://github.com/TheLocatorOfFunds/deal-command-center/actions |
| Supabase dashboard | https://supabase.com/dashboard/project/fmrtiaszjfoaeghboycn |
| Supabase SQL editor | https://supabase.com/dashboard/project/fmrtiaszjfoaeghboycn/sql/new |
| Create GitHub PAT | https://github.com/settings/tokens |
| Claude Code install | https://claude.com/claude-code |
| Architecture primer | `CLAUDE.md` in this repo |

---

## 13. First-task checklist

Use this to validate everything works end-to-end on day 1.

- [ ] Claude Code is installed and signed in
- [ ] Nathan added you as a GitHub collaborator
- [ ] Nathan invited you to the Supabase project
- [ ] You created a PAT with `repo` scope, stored it safely
- [ ] You cloned the repo to `~/Documents/deal-command-center`
- [ ] You opened Claude Code in the repo and confirmed it loaded `CLAUDE.md`
- [ ] You signed in to the live app with your email and got a magic link
- [ ] You made a tiny test change (edit a button label, etc.) and pushed
- [ ] You saw your change live on the URL after ~30 seconds
- [ ] You reverted the test change and pushed again

If all of those pass, you're set. Ping Nathan if any step blocks.

---

## 14. When in doubt

- Re-read `CLAUDE.md`. It's the source of truth for architecture decisions.
- Ask Claude. Paste the relevant section of `index.html` and describe what you want.
- Ask Nathan before anything that could affect other users' in-flight work.

Happy shipping.
