#!/bin/bash
# poll-claude-inbox.sh — DCC inter-agent message router.
#
# Polls public.team_messages on the DCC Supabase project for any
# message tagged for THIS Claude session, appends the new ones to a
# local inbox file, and tracks last_seen_at so each cron tick only
# processes new messages.
#
# Architecture: each Claude session (Nathan's, Justin's, etc.) runs
# this on a 5-minute cron. The user's tag (@nathan-ai / @justin-ai)
# tells the script which messages are addressed to them. Replies
# posted by either Claude must start with "[from " — that prefix is
# the loop-skip rule so AI ↔ AI cascades don't ping-pong forever.
#
# Per Nathan 2026-05-04 — Phase 1 of the inter-agent routing design.
# See: scripts/AGENT_INBOX_README.md
#
# Usage on each user's Mac:
#   1. Set CLAUDE_INBOX_TAG=@nathan-ai (or @justin-ai) in env
#   2. Add to crontab:
#        */5 * * * * CLAUDE_INBOX_TAG=@nathan-ai /Users/me/Documents/Claude/deal-command-center/scripts/poll-claude-inbox.sh
#   3. Open Claude Code → tell Claude "process my inbox" → it reads
#      ~/.claude-inbox/inbox.md and acts on what's there.

set -euo pipefail

# ── Config ──────────────────────────────────────────────────────────
INBOX_DIR="${HOME}/.claude-inbox"
INBOX_FILE="${INBOX_DIR}/inbox.md"
STATE_FILE="${INBOX_DIR}/last_seen_at.txt"
ENV_FILE="${HOME}/Documents/Claude/refundlocators-pipeline/config/.env"
SUPABASE_URL="https://rcfaashkfpurkvtmsmeb.supabase.co"
MY_TAG="${CLAUDE_INBOX_TAG:-@nathan-ai}"

# Soft requirement: jq is needed for parsing. macOS doesn't ship it
# by default. brew install jq.
if ! command -v jq >/dev/null 2>&1; then
  echo "[poll-inbox] jq not installed. Run: brew install jq" >&2
  exit 1
fi

mkdir -p "${INBOX_DIR}"
[ -f "${STATE_FILE}" ] || echo "1970-01-01T00:00:00Z" > "${STATE_FILE}"

# ── Service-role key from Castle's .env (already on disk, chmod 600) ─
if [ ! -r "${ENV_FILE}" ]; then
  echo "[poll-inbox] cannot read ${ENV_FILE} — needed for service key" >&2
  exit 1
fi
KEY=$(grep -E '^SUPABASE_SERVICE_KEY=' "${ENV_FILE}" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'" | sed 's/[[:space:]]*$//')
if [ -z "${KEY}" ]; then
  echo "[poll-inbox] SUPABASE_SERVICE_KEY not found in ${ENV_FILE}" >&2
  exit 1
fi

LAST_SEEN=$(cat "${STATE_FILE}")

# ── Query: messages with my tag, newer than last_seen, not deleted ──
# PostgREST: ilike with * as wildcard. We strip @ from MY_TAG for
# the URL pattern because curl's --data-urlencode handles encoding,
# but we keep the explicit %-encoded version for clarity.
RESPONSE=$(curl -fsS -G "${SUPABASE_URL}/rest/v1/team_messages" \
  --data-urlencode "select=id,thread_id,sender_id,sender_kind,body,created_at" \
  --data-urlencode "body=ilike.*${MY_TAG}*" \
  --data-urlencode "created_at=gt.${LAST_SEEN}" \
  --data-urlencode "deleted_at=is.null" \
  --data-urlencode "order=created_at.asc" \
  -H "apikey: ${KEY}" \
  -H "Authorization: Bearer ${KEY}")

# Count of total returned (incl. AI replies we'll skip below)
TOTAL=$(echo "${RESPONSE}" | jq 'length')

# Filter out AI-authored messages (loop-skip rule: replies from any
# Claude start with "[from "). Append the surviving messages to
# inbox.md. If none survive but we still saw messages, we only
# advance LAST_SEEN — the AI replies aren't appended.
NEW_HUMAN_COUNT=$(echo "${RESPONSE}" | jq '[.[] | select(.body | startswith("[from ") | not)] | length')

if [ "${NEW_HUMAN_COUNT}" -gt 0 ]; then
  TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  {
    echo
    echo "# Inbox poll · ${TS} · ${NEW_HUMAN_COUNT} new (filtered from ${TOTAL} matched)"
    echo
    echo "${RESPONSE}" | jq -r '
      .[] |
      select(.body | startswith("[from ") | not) |
      "## " + .created_at + " · sender_kind=" + (.sender_kind // "?") + " · thread=" + .thread_id + "\n" + .body + "\n"
    '
  } >> "${INBOX_FILE}"
fi

# Advance last_seen_at to the newest message we observed (skipped or
# not — we don't want to re-process them on the next tick).
LATEST=$(echo "${RESPONSE}" | jq -r 'if length > 0 then ([.[].created_at] | max) else "" end')
if [ -n "${LATEST}" ]; then
  echo "${LATEST}" > "${STATE_FILE}"
fi

# Silent on no-op so cron doesn't spam mail.
exit 0
