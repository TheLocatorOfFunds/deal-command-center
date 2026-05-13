---
description: Session-start ritual. Pull, scan WORKING_ON + session_archives + DIRECTOR interface, brief on what shipped since last session.
---

You're starting a Claude Code session on the Deal Command Center (DCC) repo. This is a
co-coded repo (Justin / Nathan / Erik each running their own Claude Code session) with a
cross-project interface to intel-main. Run the standard session-start ritual.

## Steps

Run these in parallel where possible (single message, multiple tool calls):

1. **`git pull`** — get any commits the other sessions pushed
2. **Read `WORKING_ON.md`** — every user has their own `## <Name>'s session`
   block, which may contain one or more `### <Name> · <slug>` subsections (one per
   active worktree, slug = branch with `claude/` stripped). Look at what's in flight
   on the other users AND at your own subsection (matching the branch this session
   is on) for any in-progress work a previous turn left mid-flight. If you're in a
   worktree that doesn't yet have a subsection, the Stop hook will create one on
   first heartbeat — don't manually duplicate. Skim other Justin/Nathan subsections
   so you don't step on parallel worktrees.
3. **Read `session_archives/index.md`** — the table of past sessions, newest first.
   Scan the last ~10 rows for context.
4. **For substantive recent entries** (anything that looks like it could affect what you
   might work on), read the full archive file linked in the index row
5. **Read `DIRECTOR_DCC_INTERFACE.md`** — the intel-main ↔ DCC contract. Check the
   "Last updated" date at the top; if it changed since you last saw it, re-read.
6. **`git log --since="5 days ago" --all --oneline --pretty="%h %an %s"`** — quick scan of
   what each author shipped recently. Cross-reference against archives to find the
   "Nathan/Erik shipped X without writing an archive" cases.
7. **`ls *_FROM_*.md JUSTIN_FROM_*.md NATHAN_FROM_*.md 2>/dev/null`** at repo root —
   catch any one-off handoff docs not yet folded into session_archives.

## Briefing format

After reading, produce a single concise briefing (target <300 words) with these sections:

**Since I last worked**
- 1–3 bullets on what the other sessions shipped (from `session_archives/index.md` +
  recent commits by other authors)
- Specifically flag changes that cross into my domain (per CLAUDE.md "Domain ownership")
  or touch shared tables (`deals`, `vendors`, `tasks`, `activity`, `contacts`, etc.)
- Flag any change to `DIRECTOR_DCC_INTERFACE.md`

**Action items for me**
- Anything in "Open follow-ups" in recent archive entries that targets me
- Open coordination items from `DIRECTOR_DCC_INTERFACE.md` assigned to my role
- Anything queued in my own `WORKING_ON.md` section from a paused/crashed prior session

**Where I left off**
- My subsection in `WORKING_ON.md` matching this worktree's branch (status +
  last-done + any "paused at" note). If I have other active subsections under
  my user heading, name them in one line so I remember work parked in another
  worktree.

**Watch out for**
- Gotchas from recent archive entries that touch what I'm likely to work on
- Hot rules in CLAUDE.md "Cross-project: intel-main interface" if I'll be near `deals.meta`,
  `intel_subscriptions`, or intel-sync

Be specific — name files, tables, functions, line numbers, commit hashes. No fluff, no
"let me know if you have questions" closers. Quote when useful.

After the briefing, ask: **"What are we working on today?"**
