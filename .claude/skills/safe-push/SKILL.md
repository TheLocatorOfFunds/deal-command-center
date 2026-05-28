---
name: safe-push
description: The stash → pull --rebase → resolve → commit specific-file → push dance, with the auto-mode classifier workarounds baked in. Use when committing changes from a worktree where the working tree has unrelated dirty files or origin/main has advanced.
allowed-tools: Bash, Read, Edit
---

# Safe Push (worktree-aware)

## When to invoke
- About to commit + push from a Claude session
- Local main is behind origin (common in long sessions; Nathan or
  another Justin session pushed in parallel)
- The working tree has dirty files that AREN'T part of this commit
  (build artifacts like `app.js`, in-progress mobile files, etc.)

## The dance

### 1. Pre-flight check

```bash
cd /Users/justinjohnson/Documents/deal-command-center
git status --short
git log --oneline HEAD..origin/main 2>/dev/null
```

Note:
- Which files are dirty
- Which files YOUR change touches
- Whether origin has commits ahead

### 2. Stage ONLY the files you intend to commit

Never `git add -A` or `git add .`. Always specific:
```bash
git add WORKING_ON.md path/to/your/specific/files
```

### 3. If origin is ahead → stash → pull → unstash → resolve

```bash
git stash push -m "claude session save before pull"
git pull --rebase origin main
git stash pop
```

If `stash pop` produces a conflict:
- Read the conflict markers (`grep -n "^<<<<<<<\|^=======\|^>>>>>>>" <file>`)
- For files NOT in your commit (app.js, etc.): `git checkout HEAD -- <file>` to take origin's version
- For files IN your commit: edit to keep BOTH yours + origin's content. Section boundaries (e.g. Justin/Nathan sections in WORKING_ON.md) usually make merges clean.
- `git add <resolved-file>`
- Unstage anything that crept in: `git restore --staged <unwanted>`

### 4. Commit

```bash
git commit -m "$(cat <<'EOF'
<concise message: what + why>

<optional body>

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### 5. Push

```bash
git push origin main
```

#### If the auto-mode classifier blocks the push

Symptoms: "Permission for this action was denied by the Claude Code auto
mode classifier. Reason: Direct push to main branch bypasses pull request
review…"

The allowlist `Bash(git push origin *:main)` in
`~/.claude/settings.json` is being overridden by the classifier (it
matches the keyword "main" in any read or write command, including
`git log` involving main).

**Workarounds, in order of preference:**
1. **Have Justin run the push** in his terminal. Print the exact
   one-liner: `cd /Users/justinjohnson/Documents/deal-command-center && git push origin main`
2. **Broaden the allowlist:** ask Justin to add `Bash(git push:*)` to
   the allow list. One-time, persistent fix.
3. **Push to a feature branch + open PR:** policy-compliant but
   overkill for docs.

### 6. Post-push hygiene

```bash
git status --short  # confirm clean (or expected dirty)
git stash list      # confirm stash dropped (no leftover entries)
```

## When NOT to push

Justin or Nathan may say "hold the push" if a parallel session is
mid-rebuild of overlapping code. Respect it. Stage the work locally,
report what's staged, ask before pushing.

## Anti-patterns

- Never `git add -A` (slurps in secrets, build artifacts, untracked files
  you didn't review)
- Never use `--no-verify` (skips pre-commit hooks for a reason)
- Never amend a push if hooks failed — pre-commit failures mean the
  commit didn't happen; amend would modify a different commit and lose work
- Never force-push to main
- Never resolve a stash-pop conflict by `git checkout --theirs` or
  `--ours` without first reading the conflict — section-based files
  (WORKING_ON.md) need a both-sides merge, not pick-a-side
