#!/bin/bash
#
# touch-working-on.sh — fired by the Stop hook in .claude/settings.json
# after every Claude turn. Pure shell + Python; never invokes Claude itself.
#
# What it does:
#   1. Identify which user is running this Claude session (from $USER)
#   2. Find the user's section in WORKING_ON.md
#   3. Update a "**Last updated (auto):**" line within that section to "now"
#   4. Debounce: if WORKING_ON.md was committed > 5 min ago, auto-commit
#      the heartbeat (does NOT push — Claude pushes as part of normal flow)
#
# Why: closes the failure modes where a session forgets to update its own
# state — context compaction, auto-mode, subagents, focus drift, mid-session
# crashes. Even if Claude itself never touches WORKING_ON.md, the timestamp
# moves every turn and other sessions can see "active" vs "stale > 30min".
#
# Safety: always exits 0; never blocks the session. Skips silently if not
# in a git repo, WORKING_ON.md doesn't exist, or the user isn't recognized.

set +e  # never fail loudly — this is a heartbeat, not critical path

# 1. Find repo root (works regardless of CWD)
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
[ -z "$REPO_ROOT" ] && exit 0

WORKING_ON="$REPO_ROOT/WORKING_ON.md"
[ ! -f "$WORKING_ON" ] && exit 0

# 2. Map OS user → DCC display name (case-insensitive prefix match)
USER_LC=$(echo "${USER:-unknown}" | tr '[:upper:]' '[:lower:]')
case "$USER_LC" in
  justinjohnson|justin*)   DCC_NAME="Justin" ;;
  nathan*|natejohnson*)    DCC_NAME="Nathan" ;;
  erik*)                   DCC_NAME="Erik" ;;
  *)                        exit 0 ;;  # unknown user — skip rather than guess
esac

TIMESTAMP=$(date -u +"%Y-%m-%d %H:%M UTC")

# 3. Update the "Last updated (auto):" line in the user's section
python3 - <<PYEOF >/dev/null 2>&1 || exit 0
import re, sys
path = "$WORKING_ON"
name = "$DCC_NAME"
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
new_line = f"**Last updated (auto):** {ts}"

# Update existing auto-line, or insert at end of section
auto_re = re.compile(r'^\*\*Last updated \(auto\):\*\*.*$', re.MULTILINE)
if auto_re.search(section):
    section_new = auto_re.sub(new_line, section)
else:
    section_new = section.rstrip() + '\n\n' + new_line + '\n\n'

if section_new == section:
    sys.exit(0)

content_new = content[:m.start()] + section_new + content[m.end():]
try:
    with open(path, 'w') as f:
        f.write(content_new)
except Exception:
    pass
PYEOF

# 4. Debounce-commit: only auto-commit if the file's last commit is > 5 min old.
#    This keeps the auto-heartbeat visible to other sessions without flooding
#    git history. The push happens through normal Claude commit flow, not here.
LAST_COMMIT_TS=$(cd "$REPO_ROOT" && git log -1 --format=%ct -- WORKING_ON.md 2>/dev/null)
LAST_COMMIT_TS=${LAST_COMMIT_TS:-0}
NOW=$(date +%s)
ELAPSED=$((NOW - LAST_COMMIT_TS))

# Only commit if the file is actually different from HEAD AND it's been > 5 min
if [ "$ELAPSED" -gt 300 ]; then
  cd "$REPO_ROOT" || exit 0
  if ! git diff --quiet WORKING_ON.md 2>/dev/null; then
    git add WORKING_ON.md 2>/dev/null
    git commit \
      --no-verify \
      --no-gpg-sign \
      -m "chore(working_on): ${DCC_NAME} heartbeat (auto)" \
      WORKING_ON.md \
      >/dev/null 2>&1
  fi
fi

exit 0
