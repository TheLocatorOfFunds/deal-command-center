# Pending review — migrations parked, not active

This subfolder is invisible to the migration drift CI check
(`.github/scripts/check-migrations-applied.mjs`) because the script
only reads files matching `^\d{14}_*.sql$` at the top level of
`supabase/migrations/`. Files moved here are intentionally NOT shipping
to prod yet.

Use this folder when a migration is committed-but-not-ready — typically
because it triggers customer-facing behavior (auto-emails, auto-SMS,
status broadcasts) and the team hasn't yet built the approval gate or
agreed on the rollout plan.

## How to "ship" a parked migration

1. Read it carefully — it may be stale relative to current schema
2. Build any required approval/queue UI first
3. `git mv` it back to `supabase/migrations/` (top level)
4. Apply via Supabase SQL Editor or `apply_migration` MCP
5. Push — CI check should go green

## Currently parked

### ~~`20260505100000_client_status_change_notify.sql`~~ + ~~`20260505110000_client_docket_event_notify.sql`~~ — REMOVED 2026-07-03
- **Decision (Nathan, 2026-07-03):** client notifications stay **fully
  manual** — a human writes and sends client updates; nothing auto-emails
  clients on status/docket changes. No approval-queue flow will be built.
- **Action taken:** both parked migration files deleted, and the dormant
  `notify_client_status_change()` + `notify_client_docket_event()`
  functions were `DROP`-ped from prod (they had 0 triggers — already
  inert). There is nothing left to re-attach.
- If auto-notify is ever revisited, start fresh with an approval gate;
  do not resurrect these.

### `20260505120000_client_edit_requests.sql`
- **Author:** Nathan, 2026-05-05 (parked here 2026-05-08)
- **Effect if applied:** Creates `public.client_edit_requests` table —
  a queue for clients to propose changes to their email/phone via the
  portal. Each request lands as `pending`; admin approves/rejects from
  DCC's ClientPortalCard, and approval applies the value back to
  `client_access`. RLS: clients insert + read their own; admin full
  access; VA read-only.
- **Why parked:** Schema-only — no UI built. Neither the portal-side
  "Request a correction" surface nor the DCC reviewer queue exists.
  Schema-without-UI is dead weight; either build the UI in the same
  release this ships, or delete the file.
- **State in prod:** Table does NOT exist. Nothing references it.

### `20260505210000_research_shadow_log.sql`
- **Author:** Nathan (research-agent project), 2026-05-05 — parked here
  2026-05-08
- **Effect if applied:** Creates `public.research_shadow_log` —
  Phase-1 persistence for the FundLocators Research Agent
  (`~/Documents/Claude/fundlocators-research-agent/`). Each row is
  one decision the agent WOULD have made on an Ohio-intel lead in
  shadow mode (no DCC writes). RLS: service-role write (agent),
  admin read. Unique on `(case_number, county)` for idempotency.
- **Why parked:** The research agent is scaffolded (54 tests passing,
  HMAC-verified webhook ready) but has not been pointed at real
  Ohio-intel traffic in production. Applying this table before the
  agent is live just adds an empty table.
- **State in prod:** Table does NOT exist.
- **Apply when:** The day the research agent is wired to receive real
  Ohio-intel leads in shadow mode. Apply this + `..._research_rejections`
  together (same release).

### `20260505210001_research_rejections.sql`
- **Author:** Nathan (research-agent project), 2026-05-05 — parked here
  2026-05-08
- **Effect if applied:** Creates `public.research_rejections` — durable
  audit log of every lead the research agent rejects, with structured
  reason codes (`already_claimed` / `medicaid_lien_drains_surplus` /
  `bankruptcy_filed` / etc.) and what tier the agent vs Ohio-intel
  thought it was. Unique on `(case_number, county)`. RLS: service-role
  write, admin read.
- **Why parked:** Pairs with `..._research_shadow_log`. Same situation:
  the agent code that writes here isn't pointed at production traffic
  yet.
- **State in prod:** Table does NOT exist.
- **Apply when:** Same release as `..._research_shadow_log`.

### `20260505210002_agent_room_actions.sql`
- **Author:** Nathan (agent-room project), 2026-05-05 — parked here
  2026-05-08
- **Effect if applied:** Creates `public.agent_room_actions` — audit
  log for the ops_agent daemon at `~/Documents/Claude/agent-room/`.
  Each row is one dispatch decision (action_type ∈ `db_read` /
  `db_write` / `edge_fn` / `shell` / `reply` / `defer` /
  `awaiting_confirm`) keyed off the team_messages row that triggered
  it. Phase-1 logs status=`shadow` only (no real actions). RLS:
  service-role write (daemon), admin read.
- **Why parked:** ops_agent daemon isn't running yet. The bigger
  blocker is Lauren's unified memory (memory file
  `project_lauren_unified_memory.md`) — until Lauren can remember the
  same conversation across `lauren_dm` / `lauren_room` / agent-room
  threads, she can't reliably orchestrate workers, so dispatching
  through her doesn't yet make sense.
- **State in prod:** Table does NOT exist.
- **Apply when:** Lauren unified memory ships AND the ops_agent
  daemon is deployed on defender-mini.

## Client-notify triggers — removed (see decision above)

The `notify_client_*` functions were dropped from the database on
2026-07-03 (Nathan chose fully-manual client notifications). There is
nothing to re-attach. If auto-notify ever comes back, build it fresh
behind an approval gate.
