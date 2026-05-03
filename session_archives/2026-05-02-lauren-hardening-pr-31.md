# Session 2026-05-02 — Lauren prompt-injection hardening (PR #31)

**Owner:** Nathan (Castle Claude)
**Branch(es):** `lauren-hardening-tasks-1-5`
**Related PRs:** #31

## What we set out to do

Audit the production `lauren-chat` Edge Function for prompt-injection
exposure (Justin's hardening doc Task 1), then implement the rest of
the 7-task hardening plan. Nathan's brain/tentacle security principle:
the public Lauren chat is a tentacle off the brain; it can read the
slice of brain already scoped to one visitor, but never write or pull
data across claimants.

Nathan also asked for rate limiting and to close the `lauren-internal`
auth gap (`verify_jwt: false`).

## Decisions made (durable — these change behavior going forward)

- **Brain/tentacle is the architectural rule for Lauren.** Public
  `lauren-chat` is read-only on the public KB only. Writes, external
  sends (SMS, email, DocuSign), and cross-claimant reads belong on
  `lauren-internal` (auth-gated) or on dedicated server-driven Edge
  Functions like the new `lauren-event-router`. New Lauren capabilities
  must pick a side.
- **Notifications are server-driven, not LLM-driven.** Replaces the
  prior pattern where the LLM could call `textNathan` (Twilio) on
  arbitrary user input. New path: DB trigger on `lauren_conversations`
  → `lauren-event-router` Edge Function → Resend email to
  nathan@fundlocators.com. Email-only, no SMS. Per-(visitor, signal)
  dedupe with 1h window.
- **Rate limit pattern**: per-visitor 30/hr, per-IP 60/hr via
  `lauren_rate_limit_bump()` RPC. Atomic increment-and-return. Fails
  open if RPC errors so missing migrations can't take down chat.
- **Phone number reversal stays in effect.** Deployed prompt has
  `(513) 951-8855`, which is intentional until 2306 is back up. The
  hardened version preserves 8855. Documented in the FundLocators-
  Vault `06-Decisions/2026-04-30 - Lauren phone reversal — keep 8855
  for now.md`.

## Audit findings (the four violations)

The deployed `lauren-chat` (v26, was not in git) had:

| Tool | Violation |
|---|---|
| `create_lead` | INSERT into `deals` from a `verify_jwt: false` function. Any prompt-injection could pollute the deal pipeline. |
| `textNathan` | Twilio SMS to Nathan with the LLM's chosen body. Direct attacker→Nathan-phone injection. |
| `search_dcc` | `name.ilike.${q}` against all `deals` with no `session_id` / `visitor_id` filter. Cross-claimant leak. |
| `search_ghl` | Same problem against the GoHighLevel CRM contact list. |

All four are removed in `lauren-chat/index.hardened.ts`.

## Gotchas hit (non-obvious; future sessions need to know)

- **The Supabase Edge Function source endpoint returns an ESZIP2
  binary, not raw `.ts`.** To extract: install Deno, run a script
  using `https://deno.land/x/eszip@v0.84.0` `Parser.parseBytes` →
  `getModuleSource("source/index.ts")`. The strings dump alone is
  not enough — comments and structure get lost.
- **Two parallel logging tables.** The website's `/api/lauren/log`
  writes to `lauren_conversations` (transcript JSONB, `submitted_claim`
  bool). The Edge Function writes to `lauren_sessions` (messages JSONB,
  `deal_id`). They are NOT the same table. The event router triggers
  fire on `lauren_conversations` because that's where `submitted_claim`
  flips and where the website chat-log lives.
- **Migration timestamp collision.** `system_alerts.sql` was created
  by another session at exactly `20260430220000` (same prefix as the
  Lauren event-router migration committed earlier). Both ran fine
  alphabetically (`lauren_event_router` sorts before `system_alerts`),
  but going forward the Lauren follow-on migrations bumped to
  `20260430230000+` to be safe.
- **`gh` CLI was not authed locally.** Used `gh auth login --web`
  device-flow to onboard. Future PRs from this account work without
  re-auth.
- **Credential safety**: a Supabase PAT made it into the chat
  transcript during the audit. Per the user's saved memory rule
  (`feedback_credentials_in_chat.md`), the right move is a save-to-
  disk shell snippet BEFORE token generation. We learned the hard
  way; snippet now lives in the chat history. Token revoked
  same session.

## Files / systems touched

- **Repo files:**
  - `scripts/lauren-refusal-tests/prompts.json` (53 tests across 12
    categories)
  - `scripts/lauren-refusal-tests/run.ts` (Deno runner with concurrency
    + filter + non-zero exit on fail)
  - `scripts/lauren-refusal-tests/README.md`
  - `supabase/functions/lauren-chat/index.ts` (baseline, was not in git)
  - `supabase/functions/lauren-chat/index.hardened.ts` (proposed)
  - `supabase/functions/lauren-chat/README.md`
  - `supabase/functions/lauren-internal/index.ts` (baseline)
  - `supabase/functions/lauren-internal/index.hardened.ts` (Bearer-JWT
    + role check: only `admin` / `user` / `va`)
  - `supabase/functions/lauren-internal/README.md`
  - `supabase/functions/lauren-event-router/index.ts` + `README.md`
  - `supabase/functions/lauren-daily-review/index.ts` + `README.md`
  - `WORKING_ON.md` (Nathan's section updated)
- **DB migrations (in PR, not yet pushed):**
  - `20260430220000_lauren_event_router.sql` — `lauren_alerts` table
    + 3 triggers on `lauren_conversations` + dispatch function
  - `20260430230000_lauren_rate_limit.sql` — `lauren_rate_limit` table
    + `lauren_rate_limit_bump()` RPC + 7-day cleanup cron
  - `20260430230001_lauren_daily_review_cron.sql` — pg_cron at 13:00 UTC
- **Edge functions deployed:** none. Justin owns Lauren deploys.
- **External systems:** Resend (already wired); Anthropic API (already
  wired). No new external dependencies.

## Open follow-ups (carries forward to a future session)

- [ ] Justin: review PR #31, set 2 Vault secrets, push migrations,
  deploy 4 functions (2 new, 2 hardened renames), run refusal suite
- [ ] When `(513) 516-2306` is back up, redeploy hardened lauren-chat
  with the staged on-disk prompts (per vault decision
  `2026-04-30 - Lauren phone reversal`)
- [ ] Wire a GitHub Action to run the refusal suite weekly (template
  in `scripts/lauren-refusal-tests/README.md`)
- [ ] After hardened lauren-chat ships, build outbound Lauren mode
  (event-router foundation already in place — outbound is "same brain,
  different trigger"). Nathan's stated next priority.
- [ ] Twilio + ElevenLabs voice channel — Nathan's stated priority,
  Justin's lane (Twilio is Justin's domain per CLAUDE.md ownership).
