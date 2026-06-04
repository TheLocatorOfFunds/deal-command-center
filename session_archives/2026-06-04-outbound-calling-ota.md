# Session 2026-06-04 — Outbound calling shipped via OTA + multi-session build collision

**Owner:** Justin
**Branch(es):** `justin/outbound-calling` (rebased onto `justin/eas-preview-distribution-store` @ `25dfa322`)
**Related PRs:** none yet — shipped to device via EAS Update (OTA), not a merge

## What we set out to do

Get OUTBOUND calling working end-to-end on the DCC iPhone app (Twilio Voice
SDK v1.7.0): dial → two-way audio → show deal context → clean hangup. Justin's
requirements landed on: NO "your phone will ring" modal, NO custom navy in-call
screen, and the ability to navigate DCC freely while on a call.

## Decisions made (durable — these change behavior going forward)

- **Outbound stays in-app over the Voice SDK; navy screen is suppressed for
  outbound only.** `lib/voice.ts` sets a module flag `_outboundCallActive`
  (true after a successful `connect()`, cleared on Disconnected/ConnectFailure/
  teardown) exposed via `isOutboundCallActive()`. `app/_layout.tsx`'s AppState
  'active' listener returns early when that's true, so foregrounding DCC mid-call
  does NOT push `/call/[sid]` (the navy screen). Inbound calls still open it.
- **The "your phone will ring shortly" modal is bridge-only.** `deal/[id].tsx`
  and `quick/call.tsx` return silently on the SDK path (`result.mode === 'sdk'`)
  and only show the modal on the genuine bridge-callback fallback.
- **In-call controls for outbound: left as-is.** Green pill foregrounds DCC with
  no call UI by design; native mute/speaker/end is reachable via the App Switcher.
  Justin explicitly declined a slim in-app call bar.

## Gotchas hit (non-obvious; future sessions need to know)

- **An OTA only reaches an installed build if it's published AFTER that build
  was built.** expo-updates refuses to "downgrade" to an update older than the
  running binary's embedded bundle. We shipped 4 OTAs that did nothing because
  Build 26 (built 13:20Z from the inbound session's `25dfa322`) was newer than
  all of them. The fix: rebase onto the inbound commit and publish a FRESH OTA
  (group `8077e05f`, commit `3269023`) — newer than the build, so it applies.
- **`EXPO_TOKEN` was wrapped in literal angle brackets** in the shell env
  (`<token>`, 42 chars; real token 40) → `eas` returned "bearer token is invalid"
  even though the token was valid. Strip with `EXPO_TOKEN="${EXPO_TOKEN//[<>]/}"`.
- **Use the homebrew `eas` (`/opt/homebrew/bin/eas`), not `npx eas-cli@latest`.**
  The `@latest` pull is a different binary/version than what's authenticated.
- **Two parallel Justin sessions (inbound + outbound) both push native builds to
  the same `preview` channel/runtime.** They race: whoever builds last wins the
  embedded bundle, and any OTA from a branch missing the other's commits regresses
  it. Rebasing the outbound branch onto the inbound HEAD makes one branch that
  carries both; that branch must be the source of the next native build.
- **For outgoing VoIP calls, iOS does NOT present its own call screen** (only for
  incoming). Tapping the Dynamic Island / green pill just foregrounds the owning
  app. So "tap pill for controls" requires the app to render its own in-call UI —
  there's nothing native to fall back to for outbound.

## Files / systems touched

- **Repo files:** `mobile/lib/voice.ts` (outbound flag + `isOutboundCallActive()`
  export + `contactHandle`), `mobile/lib/dial.ts` (displayName passthrough),
  `mobile/app/quick/call.tsx` (route via `placeCall`, SDK→`router.back()`),
  `mobile/app/deal/[id].tsx` (SDK path returns silently), `mobile/app/_layout.tsx`
  (additive outbound guard). `app/call/[sid].tsx` untouched.
- **DB migrations:** none
- **Edge functions deployed:** none (twilio-token / twilio-voice-outbound already live)
- **External systems:** EAS Update — OTA to channel `preview`, runtime `0.1.0`,
  branch `preview`, group `8077e05f-ff87-4be0-acea-7547cb9404e1`.

## Open follow-ups (carries forward to a future session)

- [ ] **Make the outbound fixes survive the next native build.** Next mobile build
      MUST come from `justin/outbound-calling` (already a superset of `25dfa322`),
      or FF-merge it into the build branch first. Otherwise Build 27 orphans this OTA.
- [ ] Optionally open a PR to fold `justin/outbound-calling` into the mainline mobile branch.
