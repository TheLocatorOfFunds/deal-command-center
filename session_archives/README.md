# Session Archives

Captures the durable learnings from each Claude Code session — the
decisions, gotchas, files touched, and follow-ups — so future sessions
(yours, mine, Nathan's, Erik's) can find what was figured out without
re-doing the discovery.

This directory pairs with two other things:

- **`/WORKING_ON.md`** at the repo root — **live state**, what each session
  is currently doing. Updated as you work, not just at endpoints.
- **`~/.claude/projects/<project>/memory/`** — **durable user-level
  knowledge** (decisions like "FileVault stays on", "always SSH defender-mini
  autonomously"). Survives across many sessions, narrower than session
  archives.

Session archives are the **session-by-session record** that sits in
between live state and durable memory.

## When to write an archive entry

At the end of any substantive session — i.e. one that:

- Made architectural decisions worth preserving
- Hit a non-obvious gotcha worth documenting
- Touched code/infrastructure other sessions need to know about
- Resolved a question that took >15 minutes to answer

Skip archives for trivial sessions (small bug fix, doc typo, single-PR
formatting tweak — those are sufficiently captured in the PR + git log).

## File naming

`YYYY-MM-DD-<short-slug>.md`

Examples:
- `2026-04-30-a2p-quo-imessage-architecture.md`
- `2026-04-28-mac-bridge-recovery-fileVault.md`
- `2026-04-27-team-chat-phase3-shipped.md`

If multiple sessions on the same day need archives, append a hyphen + a
short distinguisher: `2026-04-30-am-tahoe-debug.md`,
`2026-04-30-pm-quo-decision.md`.

## Format

Each entry uses this template (also see `_TEMPLATE.md`):

```markdown
# Session YYYY-MM-DD — <short title>

**Owner:** Justin | Nathan | Erik
**Branch(es):** comma-separated list of branches touched
**Related PRs:** #N, #M, …

## What we set out to do
1-3 sentences on the goal coming in.

## Decisions made (durable — these change behavior going forward)
- Bullet 1 (with rationale)
- Bullet 2

## Gotchas hit (non-obvious; future sessions need to know)
- Symptom + root cause + how we resolved it
- Repeat for each gotcha

## Files / systems touched
- repo files: list
- DB migrations: list
- Edge functions deployed: list
- External systems (Twilio, Magnetix CMS, etc.): brief

## Open follow-ups (carries forward to a future session)
- [ ] Item 1
- [ ] Item 2
```

## Updating the index

After writing your entry, **add a one-line summary to `index.md`** —
sorted by date descending. That's the file future sessions skim first
to know what's been captured.

## Don't worry about being perfect

Better to have a 100-line scrappy archive than nothing. The point is
that the next session can grep this directory for *"Tahoe"* or
*"A2P"* or *"port-in"* and find the relevant context fast. Tone and
formatting matter less than the keywords being there.
