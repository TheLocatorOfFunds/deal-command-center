# lauren-internal

DCC-only Lauren chat endpoint. Used by team members inside the Deal
Command Center to ask questions about deals, documents, docket events,
notes, tasks, and portfolio stats.

URL: `https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/lauren-internal`

## Files in this directory

- `index.ts` — currently deployed source (extracted 2026-04-30, version 19).

## ⚠ Auth gap (open follow-up for Justin)

The deployed function has **`verify_jwt: false`**, which means the URL
is reachable without auth. This is the function that has read access
to the entire `deals` table, `documents`, `docket_events`, `deal_notes`,
`tasks` — everything the team can see.

Per Nathan's brain & tentacle security principle, write power and
cross-claimant reads belong on `lauren-internal` *and* should be
auth-gated. Right now they're authoritative reads with no auth.

**Recommended fix (Justin's call to schedule):**
- Flip `verify_jwt: true` on deploy, OR
- Add an HMAC shared-secret check at the top of the function similar
  to how `notify-claim-submitted` validates `X-Notify-Claim-Submitted-Secret`,
  with the secret stored in Vault and shared only with the DCC frontend.

Today this URL is presumably not advertised, so the realistic exposure
is low — but "not advertised" is not the same as "not reachable." Worth
closing.

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
