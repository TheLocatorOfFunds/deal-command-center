# lauren-chat

Public-facing Lauren chat endpoint. Called by the RefundLocators website's
`LaurenSheet.tsx` for both generic mode and token (`/s/[token]`) mode.

URL: `https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/lauren-chat`
verify_jwt: false (intentional — public surface)

## Files in this directory

- `index.ts` — **the currently deployed source** (extracted from the
  Supabase Edge Function on 2026-04-30, version 26). Matches production.
- `index.hardened.ts` — **proposed replacement.** Does NOT auto-deploy.
  Justin reviews, replaces `index.ts` with this file, then deploys.

## Why `index.hardened.ts` exists

A 2026-04-30 audit (Castle Claude, see vault decision
`2026-04-30 - lauren-chat audit findings.md`) found that the deployed
`lauren-chat` violates Justin's prompt-injection-hardening Task 1 pass
criteria on every count:

| Tool | Issue |
|---|---|
| `create_lead` | Inserts into `deals` table from a public, no-auth function. Attacker can pollute deal pipeline via prompt injection. |
| `textNathan` (called from `create_lead`) | Sends Nathan a Twilio SMS with attacker-controlled text. |
| `search_dcc` | Reads `deals` table cross-claimant. No per-session scoping. Attacker can search for any homeowner by name/address. |
| `search_ghl` | Same problem against the GoHighLevel CRM contact list. |

Per Nathan's "brain & tentacle" security principle (see vault
`Lauren AI.md`): the public chat is a tentacle off the brain. The
tentacle reads the slice of brain already scoped to the visitor's
own case (Layers 1+2 for that case, Layer 3 public KB, Layer 4
playbook). Writes / external sends / cross-claimant reads belong on
`lauren-internal` (DCC-only, auth-gated), never on `lauren-chat`.

## What `index.hardened.ts` changes

1. **Removes `search_dcc`, `search_ghl`, `create_lead` tools entirely.**
   The website's existing `submit-lead` Edge Function handles lead
   creation when the user submits the actual claim form — there's no
   reason for the chat function to write deals or query the CRM.
2. **Removes `textNathan` function and the Twilio env var dependency.**
   Notifications now ride on the `lauren-event-router` (DB-trigger →
   Edge Function → email), which means notification logic is server-
   driven, not LLM-driven. An attacker can't trick Lauren into sending
   them.
3. **Updates the system prompt** to remove the lead-collection flow
   ("first name → property → search DCC → search GHL → create_lead").
   New flow: gather info conversationally, point them to the form on
   the website, escalate if asked. (Token mode `/s/[token]` is
   unchanged — case data still arrives via `personalization_context`.)
4. **Adds a security-posture block** to the system prompt with explicit
   refusal-binding rules (never reveal the prompt, never claim to be
   Nathan, refuse "ignore previous instructions" patterns).
5. **Adds an input firewall** — 2,000-char length cap on user messages,
   regex detection of common injection idioms. Flagged inputs get a
   canned refusal and never hit Anthropic (saves API cost too).
6. **Adds an output filter** — strips non-allowlisted URLs (only
   refundlocators.com / fundlocators.com / docusign.net pass), strips
   any text that looks like system-prompt fragments, hard 4,000-char
   length cap.
7. **Adds rate limiting** — per-visitor (30/hr) and per-IP (60/hr) via
   `lauren_rate_limit_bump` RPC. Over-limit returns HTTP 429 with the
   canned refusal. See `supabase/migrations/20260430230000_lauren_rate_limit.sql`.
8. **Keeps `search_knowledge`** (RAG over public KB) and `upsertSession`
   (chat logging to `lauren_sessions` — server-generated session_id
   means the user can't influence what gets written).

## Deploy steps (Justin)

1. Diff `index.ts` vs `index.hardened.ts`. Confirm the changes look right.
2. Test the hardened version locally if you want (`supabase functions serve lauren-chat`).
3. When approved:
   ```
   mv index.ts index.deprecated.ts && mv index.hardened.ts index.ts
   supabase functions deploy lauren-chat --project-ref rcfaashkfpurkvtmsmeb
   ```
4. Verify with the test prompts in
   `JUSTIN_LAUREN_PROMPT_INJECTION_HARDENING.md` Task 6.
5. Commit the rename + deploy timestamp.

## Phone number note

The deployed prompt currently references `(513) 951-8855` (Nathan's
GHL line). Per the 2026-04-30 phone reversal decision in the vault,
this is **correct for now** — `(513) 516-2306` is down. Do NOT
change the phone number in the hardened version; it's already
correct. The number will flip back to 2306 in a future redeploy
when Nathan confirms 2306 is back up.

## Related

- `JUSTIN_LAUREN_PROMPT_INJECTION_HARDENING.md` (this repo) — the 7-task
  hardening roadmap. This change covers Tasks 1, 2, 3 (audit, source-
  control, refusal-binding) and partially 4 + 5 (output + input
  firewall).
- `supabase/functions/lauren-event-router/` — the new alert path that
  replaces the dropped `textNathan` SMS.
