---
description: Session-end ritual. Decide substantive vs trivial, write session_archives entry from template if substantive, update WORKING_ON, propose commit.
---

You're wrapping up a Claude Code session on the Deal Command Center (DCC) repo. Co-coded
with Nathan + Erik. Run the standard session-end ritual so the next session that runs
`/catchup` gets the right context.

## Steps

### 1. Audit what changed this session

Run in parallel:
- `git log --since="6 hours ago" --author="$(git config user.email)" --oneline` (your commits)
- `git status` (staged + unstaged + untracked)
- `git diff --stat HEAD` (size of changes)

Identify what shipped, what's staged, what's still unstaged, and what's untracked.

### 2. Decide: substantive or trivial?

Per CLAUDE.md "Session end ritual", session archives are for **substantive** sessions:
> "If the session was substantive — architectural decisions made, non-obvious gotchas hit,
> or work future sessions need to know about — write a `session_archives/YYYY-MM-DD-<short-slug>.md`
> entry. Skip for trivial sessions (typo fixes, small bug PRs — those are sufficiently captured
> in the PR + git log)."

Ask me directly: **"Is this session substantive enough to archive? (y / n / partial)"** with
your own recommendation based on the diff scope. Default to writing the archive if you saw:
- A migration applied
- An Edge Function deployed or changed
- A new table / RPC / trigger / RLS policy
- A decision that future sessions need to know (architecture, naming, integration boundary)
- A non-obvious gotcha hit (something you'd want to remember next time)
- Changes to `DIRECTOR_DCC_INTERFACE.md` or any cross-project boundary

Skip the archive if it's: a single typo fix, a tiny UI tweak, a doc-only change, or a
session entirely consumed by reading/research with no code output.

### 3. Audit cross-domain impact

Re-read CLAUDE.md "Domain ownership" and "Cross-project: intel-main interface".

For each file/table you touched, classify:
- **My domain** → fine, note it in the archive's Files section
- **Shared territory** (deals, vendors, tasks, activity, deal_notes, documents, contacts,
  contact_deals, index.html shell, src/app.jsx) → fine, but explicitly call out in the archive
  so others know
- **Another session's domain** → flag prominently. Confirm with me that I coordinated it
  before committing
- **intel-main-managed `deals.meta` fields** (salePrice, isPostAuction, estimatedSurplus,
  surplusClaimStatus, walkerVerified, walkerPlatform, grade, gradeScore, lifecycleStage,
  auctionStatus, buyerName, judgmentAmount, saleDate, lastIntelSyncAt) → red flag.
  Ask me if I really meant to manually write these, since intel-main's cron will overwrite

### 4. If substantive: write the session_archives entry

Filename: `session_archives/YYYY-MM-DD-<short-kebab-slug>.md` where YYYY-MM-DD is today
and the slug is 3–8 words describing the headline of the session.

Use the template at `session_archives/_TEMPLATE.md`. Fill out every section. Concrete rules:

- **Owner**: infer from `git config user.email`. `justin@fundlocators.com` → Justin,
  `nathan@` or local hostname matches Nathan's mac → Nathan, otherwise ask
- **Branch(es)**: include the current branch name and any branch we merged from/to
- **Related PRs**: gh PR numbers if any, or "—" if none
- **What we set out to do**: 1–3 paragraphs of context. What was the trigger? What state
  was the system in when the session started?
- **Decisions made (durable)**: bullet list. Each bullet describes a decision that changes
  behavior going forward — not just what happened. Quote the diff or migration when helpful
- **Gotchas hit**: bullet list. Specific, named, with file paths / function names. Future
  sessions should be able to grep these
- **Files / systems touched**: list under each subheading. Use absolute repo paths
- **Open follow-ups**: actionable bullets, with the assignee in brackets like `[Justin]` or
  `[Nathan via Director queue]`

Match the tone and density of recent archives (e.g. `session_archives/2026-05-12-kemper-admin-leak.md`)
— specific, dense, blameless, technical.

### 5. Add a row to `session_archives/index.md`

Insert a new row at the TOP of the table (under the existing "## 2026" heading, immediately
after the header row), in this format:

```
| **YYYY-MM-DD** | <Owner> | <branch / PR> | <one-sentence summary, ending with link → [archive](./YYYY-MM-DD-<slug>.md)> |
```

The summary should be the same vibe as existing entries — punchy, technical, names dropped,
ends with the archive link.

### 6. Update `WORKING_ON.md` (always, substantive or not)

Find my section (Justin / Nathan / Erik based on `git config user.email`). Update:
- **Status**: `Idle` if cleanly done, or `Paused — <one-line>` if mid-flight
- **Last done** / **Last updated**: short summary of what landed, today's date
- If paused, add a "Resume from:" line with file path + what was in flight

**Do not touch the other users' sections.** Per CLAUDE.md, sections are owned per-user.

### 7. Propose the commit

Stage:
- The session_archives entry + index.md row (if substantive)
- `WORKING_ON.md`
- Any code changes that aren't already committed (only if I want them in this commit —
  ask me)

Propose a commit message:
```
session: <one-line summary>

<optional body — what shipped, why it matters, follow-ups>
```

If substantive, the commit message body should reference the archive file:
```
See session_archives/YYYY-MM-DD-<slug>.md for full record.
```

**Do NOT auto-commit.** Show me the staged diff and proposed message, then ask:
**"Commit this? (yes / edit message / no)"**

If yes → run the commit. If no → leave staged for me to handle.

### 8. Don't push

After the commit, say: **"Committed. Push when ready (`git push origin <branch>`), then open
PR or merge to main."** Don't push for me unless I explicitly ask. The Stop hook
(`.claude/hooks/touch-working-on.sh`) handles WORKING_ON.md auto-commit/push between turns
— this commit is the session-level record, separate from that.
