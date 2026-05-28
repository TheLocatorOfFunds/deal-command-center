---
name: session-backlog-grooming
description: Mine prior Claude Code session transcripts for "I want to build X" / "we need to fix Y" → cross-reference against open GitHub issues → file the gaps. Run monthly, or any time Justin says "what did I say I wanted last week."
allowed-tools: Bash, Read, Grep, Glob
---

# Session Backlog Grooming

## When to invoke
- Monthly cadence (first weekday of the month)
- When Justin asks "what's on my list" / "what did I say I wanted"
- When >2 weeks of sessions have happened without grooming
- After a long stretch (>1 day) of focused work — backlog catches the
  by-the-way asks that didn't get filed live

## Steps

### 1. List transcript sources
!`find ~/.claude/projects/-Users-justinjohnson-Documents-deal-command-center* -name "*.jsonl" -type f -newer ~/.claude/projects/.last-grooming 2>/dev/null | xargs ls -la 2>/dev/null | awk '{print $5, $NF}' | sort -rn | head`

If `.last-grooming` doesn't exist, scan all transcripts; sort by size (signal density).

### 2. Extract user-typed asks

For each transcript, pull only user messages (skip assistant noise):

```bash
jq -r 'select(.type=="user") |
  if (.message.content | type) == "string" then .message.content
  else (.message.content | map(select(.type=="text") | .text) | join(" "))
  end' "$f"
```

Grep patterns that signal an ask (case-insensitive):
- "I want", "I'd like", "I need"
- "we need to", "we should"
- "add the ability", "build", "let's add", "let's build"
- "fix", "broken", "doesn't work"
- "next we should", "future"
- "the mobile app needs", "in the web app"

Filter out:
- Things explicitly tabled or marked done in same session
- One-off explorations Justin abandoned
- Vague aspirations ("make it better")

### 3. Cross-reference against open issues

!`cd /Users/justinjohnson/Documents/deal-command-center && gh issue list --state all --limit 300 --json number,title,state | jq -r '.[] | "#\(.number) [\(.state)] \(.title)"'`

For each candidate ask: search the issue list for keyword overlap. If a
match exists, skip. If not, candidate for filing.

### 4. Bundle near-duplicates

Group asks that are the same feature articulated different ways
(e.g. "click number → deal" mentioned 4 times across sessions becomes
ONE issue with all source references in the body).

### 5. File missing issues

Use the existing patterns from #186–#226 as templates. Labels: `bug` or
`enhancement`, plus `web` / `mobile` / both.

**Critical:** file in batches of ≤6 or sequentially with 30s pauses,
otherwise the auto-mode classifier blocks the burst.

Pattern per issue body:
- Source quote (verbatim, ≤25 words)
- Approximate date from transcript filename mtime
- Files to touch (best guess)
- Acceptance criteria

### 6. Stamp the grooming run
!`touch ~/.claude/projects/.last-grooming`

### 7. Report

Format:
- Filed N new issues: #X through #Y
- Skipped M near-duplicates (rolled into existing #Z)
- Dropped K vague asks (listed for confirmation)

## Output expectations
- A summary message to Justin with new issue numbers
- WORKING_ON.md updated with the grooming pass (Justin's section)

## Anti-patterns

- Don't file aspirational "AI-driven pipeline" type items — they
  become permanent open issues that never close
- Don't ask Justin for permission per-issue — batch the report
- Don't promote a session-todo to an issue if it's clearly resolved
  in a later commit (check `git log --since=<date>` for the keyword)
