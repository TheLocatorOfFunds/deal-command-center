# Agent Inbox — DCC inter-agent message routing

Phase 1 of the design Nathan + Claude sketched on 2026-05-04. Lets you talk to "the other person's Claude" through DCC team chat.

## How it works (one-line version)

Each user's Claude has a tag (`@nathan-ai`, `@justin-ai`). Anyone posting a `team_message` containing that tag triggers the target Claude on its next 5-min cron tick. The Claude appends the message to a local inbox, processes it on the next session, and replies in the same thread with a `[from X's claude]:` prefix.

## Conventions (read first; they prevent loops)

| Convention | Why |
|---|---|
| `@nathan-ai <body>` | Routes to Nathan's Claude session |
| `@justin-ai <body>` | Routes to Justin's Claude session |
| `[from nathan's claude]: <body>` | Reply from Nathan's Claude. Other agents IGNORE it (loop-skip rule). |
| `[from justin's claude]: <body>` | Reply from Justin's Claude. Same rule. |
| Latency | ~5 min average, max 5 min worst case (cron tick) |

If you want lower latency, dial the cron to `* * * * *` (1 min) — burns 5x the cycles for snappier handoff.

## Setup on Nathan's Mac (already done if you're reading this on Nathan's machine)

```bash
# 1. Install jq if missing
brew install jq

# 2. Crontab entry
( crontab -l 2>/dev/null; echo '*/5 * * * * CLAUDE_INBOX_TAG=@nathan-ai /Users/alexanderthegreat/Documents/Claude/deal-command-center/scripts/poll-claude-inbox.sh' ) | crontab -

# 3. Verify it's installed
crontab -l | grep poll-claude-inbox
```

The script reuses the Supabase service-role key already on disk at `~/Documents/Claude/refundlocators-pipeline/config/.env` (Castle's `.env`). No new credential to manage.

Inbox lands at `~/.claude-inbox/inbox.md`. Last-seen state at `~/.claude-inbox/last_seen_at.txt`.

## Setup on Justin's Mac

```bash
# 1. Make sure Justin has the deal-command-center repo cloned, and
#    Castle's repo (refundlocators-pipeline) cloned with the .env
#    file populated (same SUPABASE_SERVICE_KEY Nathan uses).
brew install jq

# 2. Crontab entry — note the tag
( crontab -l 2>/dev/null; echo '*/5 * * * * CLAUDE_INBOX_TAG=@justin-ai /Users/justin/Documents/Claude/deal-command-center/scripts/poll-claude-inbox.sh' ) | crontab -
```

Justin's inbox lands at `~/.claude-inbox/inbox.md` on his machine.

## Sending a message

In the Justin↔Nathan DM (or any thread you both have access to), post a `team_message` with the target tag:

> `@justin-ai pls audit the tier scoring on Casey Jennings — she keeps showing up unscored even after Eric tried to set her`

Justin's cron picks it up within 5 min. Justin's next Claude session will see it in his inbox and act.

## What "act" means

When Claude reads `~/.claude-inbox/inbox.md`, it should:

1. Process each message (do the work — query DCC, run a script, etc.)
2. Post a reply back to the SAME thread with the `[from <name>'s claude]:` prefix
3. Optionally clear or archive `inbox.md` so the next session doesn't re-process

Replies are visible to the asker (the human) AND the asker's Claude monitor (which skips them by the `[from` prefix rule).

## What's safe to auto-fire vs. needs human confirm

Recommended allowlist for Phase 1 — Claude can auto-fire these without human confirmation:

- DB reads of any kind
- Posting messages back to team chat
- Read-only RPC calls (lookups, counts)
- Adding tags to deals
- Marking notes / tasks read

Recommended blocklist — Claude should propose to its human owner instead of auto-firing:

- `git push` / `git rebase` / anything that mutates main
- Database migrations
- Edge Function deploys
- Financial actions (sending money, completing trades)
- Bulk-deletes
- Mass external sends (SMS / email at scale)
- Anything destructive

The script itself doesn't enforce this — it only delivers the message. The Claude that processes the message is responsible for the safety judgement.

## Uninstalling

```bash
# Remove cron entry
crontab -l | grep -v poll-claude-inbox | crontab -

# Wipe state
rm -rf ~/.claude-inbox
```

## Phase 2 ideas (not built yet)

- Per-task threads instead of one shared DM (ask Claude to spawn a fresh `team_thread` for each multi-turn delegation)
- Real-time webhook instead of cron (lower latency)
- Auto-reply with Claude SDK in headless mode (no human-in-the-loop wake-up; agent pure-autonomous)
