#!/bin/bash
#
# touch-working-on.sh — fired by the Stop hook in .claude/settings.json
# after every Claude turn. Pure shell + Python; never invokes Claude itself.
#
# What it does:
#   1. Identify which user is running this Claude session (git email → DCC name)
#   2. Identify which worktree this session is in (branch name → slug)
#   3. Find the user's section in WORKING_ON.md, then the per-worktree
#      subsection (### <Name> · <slug>) inside it
#   4. Update a "**Last updated (auto):**" line within that subsection to "now"
#      (creating the subsection if missing — so a fresh worktree shows up
#      immediately rather than waiting for Claude to write content)
#   5. Debounce: if WORKING_ON.md was last committed > 2 min ago, auto-commit
#      the heartbeat (does NOT push — Claude pushes as part of normal flow)
#
# Why per-worktree subsections (2026-05-13): one user running two Claude Code
# worktrees in parallel was racing on the same flat user section, producing
# merge conflicts at PR-merge time. Each worktree now owns its own
# `### <Name> · <slug>` block, so concurrent edits target different lines and
# git's automatic merge resolves them cleanly.
#
# Safety: always exits 0; never blocks the session. Skips silently if not
# in a git repo, WORKING_ON.md doesn't exist, or the user isn't recognized.

set +e  # never fail loudly — this is a heartbeat, not critical path

# 1. Find repo root (works regardless of CWD; resolves to the worktree root,
#    not the main checkout — each worktree has its own working copy of
#    WORKING_ON.md and commits to its own branch).
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
[ -z "$REPO_ROOT" ] && exit 0

WORKING_ON="$REPO_ROOT/WORKING_ON.md"
[ ! -f "$WORKING_ON" ] && exit 0

# 2. Identify which DCC user is running this session.
#    Primary signal: git config user.email — already set on each user's Mac
#    so commits are attributed correctly. Way more reliable than $USER
#    (which varies by Mac home-directory naming) or any hardcoded mapping.
#    Fallback: $USER prefix match — kept as a safety net in case git email
#    isn't configured.
GIT_EMAIL=$(cd "$REPO_ROOT" && git config user.email 2>/dev/null | tr '[:upper:]' '[:lower:]')

DCC_NAME=""
case "$GIT_EMAIL" in
  justin@fundlocators.com|justin@refundlocators.com|justinjohnson*)  DCC_NAME="Justin" ;;
  nathan@fundlocators.com|nathan@refundlocators.com|nathanjohnson*|nate*) DCC_NAME="Nathan" ;;
  admin3@fundlocators.com|erik@*)                                   DCC_NAME="Erik" ;;
esac

# Fallback to OS username if git email didn't resolve
if [ -z "$DCC_NAME" ]; then
  USER_LC=$(echo "${USER:-unknown}" | tr '[:upper:]' '[:lower:]')
  case "$USER_LC" in
    justinjohnson|justin*)   DCC_NAME="Justin" ;;
    nathan*|natejohnson*)    DCC_NAME="Nathan" ;;
    erik*|admin3*)           DCC_NAME="Erik" ;;
    *)                        exit 0 ;;  # unknown — skip rather than guess
  esac
fi

# 3. Identify which worktree this session is in.
#    Branch name is the most stable signal: each parallel worktree runs on
#    its own branch (Claude Code's convention is `claude/<slug>`). Strip the
#    `claude/` prefix for readability — keeps the subsection heading tidy.
#    Edge cases:
#      - main checkout on `main` → slug = "main"
#      - detached HEAD → slug = "detached" (rare; sessions don't usually run here)
#      - non-claude branch (e.g. `chore/foo`) → slug = "chore/foo" (kept as-is)
BRANCH=$(cd "$REPO_ROOT" && git rev-parse --abbrev-ref HEAD 2>/dev/null)
if [ -z "$BRANCH" ] || [ "$BRANCH" = "HEAD" ]; then
  BRANCH="detached"
fi
SLUG="${BRANCH#claude/}"

TIMESTAMP=$(date -u +"%Y-%m-%d %H:%M UTC")

# 4. Update (or create) the per-worktree subsection inside the user's section
python3 - "$WORKING_ON" "$DCC_NAME" "$SLUG" "$BRANCH" "$TIMESTAMP" <<'PYEOF' >/dev/null 2>&1 || exit 0
import re, sys

path, name, slug, branch, ts = sys.argv[1:6]

try:
    with open(path, 'r') as f:
        content = f.read()
except Exception:
    sys.exit(0)

# Find "## <Name>'s session" parent section (up to next "## " or EOF)
section_re = re.compile(
    rf"(## {re.escape(name)}'s session\b.*?)(?=^## |\Z)",
    re.DOTALL | re.MULTILINE,
)
m = section_re.search(content)
if not m:
    sys.exit(0)

section = m.group(1)

# Find the per-worktree subsection: "### <Name> · <slug>" (up to next "### " / "## " / EOF)
sub_re = re.compile(
    rf"(### {re.escape(name)} · {re.escape(slug)}\b.*?)(?=^### |^## |\Z)",
    re.DOTALL | re.MULTILINE,
)
sm = sub_re.search(section)

new_line = f"**Last updated (auto):** {ts}"
auto_re = re.compile(r'^\*\*Last updated \(auto\):\*\*.*$', re.MULTILINE)

if sm:
    # Update the timestamp inside the existing subsection
    sub = sm.group(1)
    if auto_re.search(sub):
        sub_new = auto_re.sub(new_line, sub)
    else:
        sub_new = sub.rstrip() + "\n\n" + new_line + "\n"
    section_new = section[:sm.start()] + sub_new + section[sm.end():]
else:
    # No subsection for this worktree yet — append a minimal stub at the end
    # of the parent section. Claude fills in real content when it next writes
    # to its section; until then, other sessions still see this worktree
    # exists and when it last heartbeat'd.
    today = ts.split(" ")[0]
    stub = (
        f"\n### {name} · {slug}\n\n"
        f"**Status:** Active — {today}\n"
        f"**Branch:** `{branch}` (worktree)\n"
        f"**Working on:** _auto-created by Stop hook — Claude will fill this in_\n\n"
        f"{new_line}\n"
    )
    section_new = section.rstrip() + "\n" + stub + "\n"

if section_new == section:
    sys.exit(0)

content_new = content[:m.start()] + section_new + content[m.end():]
try:
    with open(path, 'w') as f:
        f.write(content_new)
except Exception:
    pass
PYEOF

# 5. Debounce-commit: only auto-commit if the file's last commit is > 2 min old.
#    This keeps the auto-heartbeat visible to other sessions without flooding
#    git history. The push happens through normal Claude commit flow, not here.
#    Each worktree commits to its own branch, so concurrent worktrees don't
#    race at the git level (only at the merge-to-main level, which the
#    subsection structure resolves).
LAST_COMMIT_TS=$(cd "$REPO_ROOT" && git log -1 --format=%ct -- WORKING_ON.md 2>/dev/null)
LAST_COMMIT_TS=${LAST_COMMIT_TS:-0}
NOW=$(date +%s)
ELAPSED=$((NOW - LAST_COMMIT_TS))

if [ "$ELAPSED" -gt 120 ]; then
  cd "$REPO_ROOT" || exit 0
  if ! git diff --quiet WORKING_ON.md 2>/dev/null; then
    git add WORKING_ON.md 2>/dev/null
    git commit \
      --no-verify \
      --no-gpg-sign \
      -m "chore(working_on): ${DCC_NAME} · ${SLUG} heartbeat (auto)" \
      WORKING_ON.md \
      >/dev/null 2>&1
  fi
fi

exit 0
