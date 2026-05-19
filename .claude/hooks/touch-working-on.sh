#!/bin/bash
#
# touch-working-on.sh — fired by the Stop hook in .claude/settings.json
# after every Claude turn. Pure shell + Python; never invokes Claude itself.
#
# What it does:
#   1. Identify which user is running this Claude session (from git email / $USER)
#   2. Identify which WORKTREE this session is in (basename of git toplevel,
#      or "main" if it's the main worktree)
#   3. Find/create a "### <User> · <worktree-slug>" subsection inside that
#      user's section in WORKING_ON.md
#   4. Update a "**Last updated (auto):**" line inside THAT subsection only
#   5. Debounce: if WORKING_ON.md was committed > 2 min ago, auto-commit
#      the heartbeat (does NOT push — Claude pushes as part of normal flow)
#
# Why per-worktree subsections: a single user (e.g. Justin) running two
# parallel Claude Code worktrees would otherwise both fight over the same
# user-level section and produce merge conflicts. Each worktree now owns
# its own subsection.
#
# Why the hook at all: closes the failure modes where a session forgets
# to update its own state — context compaction, auto-mode, subagents,
# focus drift, mid-session crashes. Even if Claude itself never touches
# WORKING_ON.md, the timestamp moves every turn and other sessions can
# see "active" vs "stale > 30min".
#
# Safety: always exits 0; never blocks the session. Skips silently if not
# in a git repo, WORKING_ON.md doesn't exist, or the user isn't recognized.

set +e  # never fail loudly — this is a heartbeat, not critical path

# 1. Find repo root (works regardless of CWD) — this is the WORKTREE root,
#    not the shared git common dir. Each worktree has its own toplevel.
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

# 3. Identify the worktree slug. Each worktree has a unique filesystem path,
#    so basename of git toplevel is a stable per-worktree identifier.
#    Special case: if we're in the main worktree (basename == repo name
#    "deal-command-center"), call the slug "main" for readability.
WORKTREE_SLUG=$(basename "$REPO_ROOT")
[ "$WORKTREE_SLUG" = "deal-command-center" ] && WORKTREE_SLUG="main"

# Branch name (informational, written into the subsection body on first creation)
BRANCH_NAME=$(cd "$REPO_ROOT" && git rev-parse --abbrev-ref HEAD 2>/dev/null)
[ -z "$BRANCH_NAME" ] && BRANCH_NAME="(detached)"

TIMESTAMP=$(date -u +"%Y-%m-%d %H:%M UTC")

# 4. Update or create the per-worktree subsection inside the user's section
python3 - <<PYEOF >/dev/null 2>&1 || exit 0
import re, sys
path = "$WORKING_ON"
name = "$DCC_NAME"
slug = "$WORKTREE_SLUG"
branch = "$BRANCH_NAME"
ts = "$TIMESTAMP"

try:
    with open(path, 'r') as f:
        content = f.read()
except Exception:
    sys.exit(0)

# Match "## <Name>'s session" up to (but not including) the next "## " heading
section_re = re.compile(
    rf'(## {re.escape(name)}\'s session\b.*?)(?=^## |\Z)',
    re.DOTALL | re.MULTILINE
)
m = section_re.search(content)
if not m:
    sys.exit(0)

section = m.group(1)
new_auto_line = f"**Last updated (auto):** {ts}"

# Inside the user section, look for "### <Name> · <slug>" subsection
sub_re = re.compile(
    rf'(### {re.escape(name)} · {re.escape(slug)}\b.*?)(?=^### |^## |\Z)',
    re.DOTALL | re.MULTILINE
)
sm = sub_re.search(section)

if sm:
    # Subsection exists — update or insert its auto-line
    sub = sm.group(1)
    auto_re = re.compile(r'^\*\*Last updated \(auto\):\*\*.*$', re.MULTILINE)
    if auto_re.search(sub):
        sub_new = auto_re.sub(new_auto_line, sub)
    else:
        sub_new = sub.rstrip() + '\n\n' + new_auto_line + '\n\n'
    section_new = section[:sm.start()] + sub_new + section[sm.end():]
else:
    # Subsection doesn't exist — create at end of user section
    subsection_block = (
        f"\n### {name} · {slug}\n\n"
        f"**Branch:** `{branch}`\n"
        f"{new_auto_line}\n\n"
    )
    section_new = section.rstrip() + '\n' + subsection_block

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
LAST_COMMIT_TS=$(cd "$REPO_ROOT" && git log -1 --format=%ct -- WORKING_ON.md 2>/dev/null)
LAST_COMMIT_TS=${LAST_COMMIT_TS:-0}
NOW=$(date +%s)
ELAPSED=$((NOW - LAST_COMMIT_TS))

# Only commit if the file is actually different from HEAD AND it's been > 2 min
if [ "$ELAPSED" -gt 120 ]; then
  cd "$REPO_ROOT" || exit 0
  if ! git diff --quiet WORKING_ON.md 2>/dev/null; then
    git add WORKING_ON.md 2>/dev/null
    git commit \
      --no-verify \
      --no-gpg-sign \
      -m "chore(working_on): ${DCC_NAME} heartbeat (auto, ${WORKTREE_SLUG})" \
      WORKING_ON.md \
      >/dev/null 2>&1
  fi
fi

exit 0
