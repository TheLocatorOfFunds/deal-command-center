# lauren-internal

DCC-only Lauren chat endpoint. Used by team members inside the Deal
Command Center to ask questions about deals, documents, docket events,
notes, tasks, and portfolio stats.

URL: `https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/lauren-internal`

## Files in this directory

- `index.ts` — currently deployed source (extracted 2026-04-30, version 19).

## ⚠ Auth gap — proposed fix in `index.hardened.ts`

The currently-deployed function has **`verify_jwt: false`** and zero
auth checks of its own. This is the function that has read access to
the entire `deals` table, `documents`, `docket_events`, `deal_notes`,
and `tasks` — everything the team can see. URL-only access without
auth means anyone who learns the URL can ask Lauren to summarize any
deal in the system.

**`index.hardened.ts` (proposed replacement)** decodes the Bearer
token (same idiom `send-email` uses), looks up the user's role in
`profiles`, and allows only `admin` / `user` / `va`. Attorneys,
clients, and unauthenticated callers get 401 / 403.

Justin's call to deploy: same flow as for `lauren-chat` —
`mv index.hardened.ts -> index.ts`, then deploy. Verify the DCC
frontend is forwarding the user's Bearer token when it calls
`lauren-internal` (probably already is — look for whatever component
mounts the internal Lauren chat panel).

## Tools exposed

Read-only against the DCC's data:

| Tool | Reads |
|---|---|
| `search_deals` | `deals` (by name/address) |
| `list_deals` | `deals` (filtered by type/status/county) |
| `get_deal` | `deals` (single, full row) |
| `get_deal_documents` | `documents` |
| `get_docket_events` | `docket_events` |
| `get_deal_notes` | `deal_notes` |
| `get_tasks` | `tasks` |
| `summarize_portfolio` | `deals` (aggregate) |

No write tools. No external sends. This is the read-from-the-brain
side of the architecture; the public `lauren-chat` is the
read-only-tentacle side.

## Related

- `supabase/functions/lauren-chat/` — public-facing surface
- `JUSTIN_LAUREN_PROMPT_INJECTION_HARDENING.md` — security roadmap
