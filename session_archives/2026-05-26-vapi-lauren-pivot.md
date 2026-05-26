# Session 2026-05-26 — Vapi voice agent: pivot to Lauren-as-brain

**Owner:** Justin
**Branch(es):** `claude/mobile-feature-parity-p3pPZ`
**Related PRs:** none open yet (commits `cfd5b53`, `13c4cd1`, plus the
prior staging commit `4b851be` on `main`)
**Related issue:** #210

## What we set out to do

Issue #210 staged a full Vapi voice-agent integration where Vapi would
own the LLM (Vapi-attached Claude with a Vapi-side system prompt). Spent
the session reviewing it before standing up the Vapi account, realized
we'd be re-implementing Lauren's 225-line homeowner-safe prompt + 4-layer
safety filters from scratch inside Vapi — duplicating Nathan's existing
prompt-engineering work on `lauren-chat`. Pivoted to "Vapi-as-transport,
Lauren-as-brain": Vapi handles voice (SIP, STT, TTS, turn-taking) and
calls OUR endpoint as a Custom LLM. Lauren's brain answers chat AND
voice from one prompt. Then automated as much of the rollout as can
be done without sharing credentials.

## Decisions made (durable — these change behavior going forward)

- **Single Lauren brain across surfaces.** New shared module
  `supabase/functions/_shared/lauren-brain.ts` is the source of truth
  for SYSTEM prompt, VOICE_ADDENDUM (voice-specific brevity rules),
  TOOLS catalog, safety filters (input firewall, output sanitizer,
  rate limit), and the caller-phone → case-context resolver. When
  Nathan tunes Lauren, both chat + voice update.

- **`lauren-chat` not migrated in this PR.** The web widget on
  refundlocators.com keeps its inline SYSTEM constant. Reason: a
  refactor that breaks the production widget would be very visible
  (see "Lauren is temporarily offline" incident in WORKING_ON.md
  emergency block at the top). Follow-up PR will move `lauren-chat`
  to import from `_shared/` after `lauren-voice` is proven working.
  During the gap, SYSTEM is duplicated — drift is the risk; mitigation
  is keeping the gap short.

- **No tool calls in voice v1.** `lauren-voice` doesn't expose
  `search_knowledge` or any other tools to Claude during the call.
  Reason: each tool-call iteration adds 1-3s of latency and Vapi's
  per-turn budget is ~2s. Lauren's system prompt already encodes the
  fee objection / scam pushback / probate / timeline responses inline
  (~225 lines worth), so she can answer 80% of objections without
  tooling. Add `case_status` / `recent_outreach` later as needed —
  non-breaking when added.

- **Voicemail-as-backup at the Twilio layer, not Vapi.** Updated
  `twilio-voice-status` to chain `<Say>` + `<Record>` AFTER the Vapi
  `<Dial timeout="10">` so a Vapi outage doesn't silently drop calls.
  TwiML's `action` attribute means the same EF handles the post-dial
  callback. Previously a Vapi failure = dead air; now it falls through
  to voicemail within 10 seconds.

- **`vapi-lookup-deal` Edge Function deleted.** Its job (caller phone
  → contact → deal briefing) is subsumed by lauren-voice's inline
  resolver in `_shared/lauren-brain.ts → resolveCallerContext()`,
  called on every turn (cheap, stateless on our side since Vapi sends
  the full transcript each turn). One fewer function to deploy + auth.

- **Deploy via GitHub Actions, not local CLI.** New workflow
  `.github/workflows/deploy-functions.yml` (workflow_dispatch only,
  reuses existing `SUPABASE_PAT` secret as `SUPABASE_ACCESS_TOKEN`).
  Click "Run workflow" in GH UI, type function names, done. Removes
  the "have you installed the Supabase CLI?" friction for any future
  session that wants to ship a function.

- **`npm run vapi-create-assistant`** for the Vapi assistant POST.
  Wraps api.vapi.ai with idempotency check (won't dupe if "Lauren —
  RefundLocators" already exists). Prompts interactively for missing
  env vars + auto-generates `VAPI_LLM_SECRET`. Avoids cURL JSON
  escaping pain.

## Gotchas hit (non-obvious; future sessions need to know)

- **Vapi Custom LLM is OpenAI-streaming-compatible only.** Anthropic
  Messages API returns SSE in a different shape (`content_block_delta`
  events with `text_delta` payloads) than OpenAI Chat Completions
  (`choices[0].delta.content`). `lauren-voice` does on-the-fly
  translation: reads Anthropic's stream, emits OpenAI-format chunks.
  See `supabase/functions/lauren-voice/index.ts → streamAnthropicAsOpenAI`.

- **OpenAI's first chunk must declare role.** Vapi's OpenAI client
  expects the first SSE chunk to have `delta: { role: "assistant",
  content: "" }`, THEN subsequent chunks with `delta: { content: "..." }`.
  Skipping the role declaration sometimes works, sometimes hangs the
  client. We always emit it.

- **Anthropic requires alternating user/assistant messages.** OpenAI
  is more permissive (allows consecutive same-role). When Vapi sends
  weird message orderings, our `translateMessages()` collapses adjacent
  same-role turns into one. Without this, the Anthropic call 400s.

- **Caller phone path varies between Vapi API versions.** Defensive
  read from multiple candidates: `call.customer.number`,
  `call.customer.phoneNumber`, `customer.number`, `phoneNumber.number`,
  `metadata.callerNumber`, `metadata.caller_phone`. See
  `lauren-voice → extractCallerPhone()`.

- **`_shared/` is new to this codebase.** No prior Edge Function imports
  cross-directory files; lauren-voice is the first. Supabase CLI's
  `functions deploy <name>` does bundle `_shared/` automatically (per
  Supabase docs), but if someone deploys via a non-CLI path (raw API
  upload) they need to include the file. The GH Actions workflow uses
  the CLI, so it Just Works.

- **`max_tokens=256` on voice replies.** Tight cap that combined with
  VOICE_ADDENDUM ("1 or 2 short sentences") keeps replies short enough
  for TTS to finish before the caller jumps in. If Lauren ever rambles
  in prod, drop to 150 first; trimming the system prompt is a last
  resort (it's well-tuned).

## Files / systems touched

- **Repo files:**
  - NEW: `supabase/functions/_shared/lauren-brain.ts`
  - NEW: `supabase/functions/lauren-voice/index.ts`
  - DEL: `supabase/functions/vapi-lookup-deal/`
  - MOD: `supabase/functions/twilio-voice-status/index.ts` (voicemail fallback)
  - MOD: `supabase/config.toml` (registered lauren-voice, removed vapi-lookup-deal)
  - NEW: `.github/workflows/deploy-functions.yml`
  - NEW: `scripts/vapi-create-assistant.mjs` + `package.json` script entry
  - NEW: `docs/VAPI_SETUP.md` (6-step runbook)

- **DB migrations:** none in this session. Three migrations from the
  prior staging commit (`4b851be` on main) still need to be applied
  to prod via SQL editor:
  - `20260523120000_push_notify_voicemail_landed.sql`
  - `20260523120100_call_logs_voice_intake.sql`
  - `20260523120200_push_notify_agent_intake.sql`

- **Edge functions deployed:** none yet — `lauren-voice` +
  `twilio-voice-status` need to deploy via the new GH Action.
  `vapi-lookup-deal` was never deployed (deleted before first deploy).

- **External systems:** Vapi account NOT yet created (Justin to do).
  Twilio routing unchanged. Anthropic API costs unchanged (same key).

## Open follow-ups (carries forward to a future session)

- [ ] Justin completes Vapi rollout per `docs/VAPI_SETUP.md` steps 1, 3,
      4, 6. Step 2 via `npm run vapi-create-assistant`. Step 5 via GH
      Actions.
- [ ] After voice is verified working: migrate `lauren-chat` to import
      from `_shared/lauren-brain.ts`. Should be a mechanical refactor
      (already done once on this branch, reverted for safety — see the
      first commit `cfd5b53` diff for the shape it took).
- [ ] Apply the 3 staged migrations to prod (they're committed but
      unapplied; will trip the migration-drift CI check eventually).
- [ ] Once first real call lands: pull the Vapi end-of-call-report
      shape from logs and tighten `vapi-webhook/index.ts` defensive
      multi-path parsing if the real shape differs from our guess.
- [ ] Optional: add `case_status` + `recent_outreach` tools to
      lauren-voice. Add when first real call reveals Lauren needs
      mid-call data the system prompt doesn't carry.
