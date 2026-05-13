# In-App Dialer Spec (DCC mobile)

Build native CallKit-integrated voice calling into the DCC iOS app via
Twilio's React Native Voice SDK. Replaces the current bridge-callback
flow (where the user's personal cell rings first) with a true in-app
voice connection.

Status: **in progress** on branch `justin/mobile-dialer`.
Owner: Justin (with Claude).

---

## Goals

1. **Outbound**: tap a phone number anywhere in DCC mobile → app dials
   the destination directly over a real VoIP connection. Recipient
   sees `+1 513 998 5440` (FundLocators Twilio) as caller ID.
2. **Inbound**: calls to `+1 513 998 5440` ring **simultaneously** in:
   - every signed-in DCC web browser session (already working)
   - every signed-in DCC mobile app session
   - **plus** Nathan's iPhone at `2306` as an always-on fallback
3. **Deal context on every call** — both inbound and outbound — auto-
   populate from `contacts.phone` → `contact_deals` → `deals` lookup.
4. **CallKit integration** — calls feel native (lock-screen UI,
   AirPods/Bluetooth audio routing, calls appear in iPhone Recents).

## Non-goals (deferred)

- Android (mobile is iOS-only for V1)
- Web dialer changes (the web app already has Voice SDK wired up)
- Conference calling / call transfer
- Call recording UI in the app (server-side recording is already happening)
- Voicemail playback in the app (continues to live in `call_logs`)

## Existing infrastructure to reuse

| Piece | What it does | Status |
|---|---|---|
| `supabase/functions/twilio-token` | Issues Voice SDK access tokens (identity = `dcc-fundlocators` shared across all team members) | ✅ Built |
| `supabase/functions/twilio-voice` | Inbound TwiML — looks up deal/contact + rings every `<Client>` registered with shared identity | ✅ Built |
| `supabase/functions/twilio-voice-outbound` | Outbound TwiML when the SDK calls a number | ✅ Built |
| `supabase/functions/twilio-voice-status` | Call lifecycle webhook → updates `call_logs` rows | ✅ Built |
| `supabase/functions/twilio-recording` | Recording status callback | ✅ Built |
| `call_logs` table | Every call recorded with deal/contact context | ✅ Built |
| `mobile/lib/dial.ts` | Legacy bridge-callback dialer | ⚠️ **Replacing** — will keep around for fallback initially |

## Routing rules (Option A: parallel-ring)

When a call hits `+1 513 998 5440`:

1. `twilio-voice` Edge Function fires
2. Lookup deal/contact from `contacts.phone` → `contact_deals` (same logic as today)
3. Return TwiML that **simultaneously dials**:
   - `<Client><Identity>dcc-fundlocators</Identity></Client>` — rings every web browser + mobile app registered with that identity
   - `<Number>+15139982306</Number>` — rings Nathan's Spectrum iPhone as parallel safety net
4. **AMD (Answering Machine Detection)** enabled on the `<Number>` leg
   so Nathan's voicemail doesn't "answer" the call at ~15 sec and kill
   every other leg before any human picks up. AMD is a Twilio param:
   `machineDetection="DetectMessageEnd"` with `machineDetectionTimeout=10`.
5. First leg with a confirmed human pickup wins; Twilio cancels the
   others automatically.
6. If nobody picks up in 30 sec, hand off to the missed-call flow that
   already exists in `twilio-voice-status` (logs `no-answer`, fires
   the auto-SMS to the caller).

## Outbound flow

1. User taps a number in DCC mobile (Deal Detail, Contact, Inbox thread, FAB)
2. Mobile calls `placeCall(toNumber, {dealId, contactId})` in `mobile/lib/voice.ts`
3. Voice SDK invokes `voice.connect({to: toNumber, dealId, contactId})` with custom params
4. Twilio routes to `twilio-voice-outbound` Edge Function via the TwiML App SID
5. `twilio-voice-outbound` returns `<Dial callerId="+15139985440">{toNumber}</Dial>`
6. CallKit shows the "calling..." UI on the iPhone (lock-screen capable)
7. When destination answers, audio bridges via Twilio
8. `twilio-voice-status` logs the call to `call_logs` with deal/contact metadata

## Inbound flow (mobile)

1. Someone calls `+1 513 998 5440`
2. `twilio-voice` returns TwiML with `<Client>` for all SDK identities + `<Number>` for 2306
3. For each registered mobile device with the `dcc-fundlocators` identity, Twilio sends a **VoIP push notification** via Apple's PushKit
4. Mobile receives the push (even if app is killed — PushKit can wake it)
5. App reports the incoming call to **CallKit**, which shows the native call UI
6. User taps Accept → Voice SDK accepts → audio flows
7. The custom parameters (`dealId`, `dealName`, `contactId`) populate the in-call screen header

## Architecture decisions

- **Single shared identity** (`dcc-fundlocators`) — already established
  by `twilio-token`. Mobile registers under same identity as web. No
  per-user routing complexity.
- **CallKit + PushKit** are mandatory iOS integrations — Apple requires
  CallKit for any voice-over-IP app to use the standard call UI. PushKit
  is the only way to wake a killed app for an incoming call.
- **Expo config plugin** — Twilio's React Native SDK needs native iOS
  setup (entitlements, Info.plist keys, framework links). Custom config
  plugin at `mobile/plugins/with-twilio-voice.js` injects these into the
  EAS prebuild output. Avoids `npx expo prebuild` and keeps us in the
  managed workflow.
- **AMD for the 2306 leg** — Twilio's `machineDetection="DetectMessageEnd"`
  detects voicemail vs human. Voicemail leg is cancelled before it can
  "answer." Tested pattern, supported by all carriers.

## New code to write

### Mobile
- `mobile/package.json` — add `@twilio/voice-react-native-sdk`
- `mobile/plugins/with-twilio-voice.js` — Expo config plugin for native setup
- `mobile/app.json` — register the config plugin + add VoIP background mode
- `mobile/lib/voice.ts` — Voice SDK wrapper (replaces `dial.ts` over time)
- `mobile/app/call/[id].tsx` — in-call screen with deal-context header
- `mobile/app/_layout.tsx` — Voice SDK initialization + PushKit token registration on app launch

### Edge Functions
- `twilio-token/index.ts` — extend to accept + register the mobile PushKit token alongside the access token (one-line change to Twilio API call)
- `twilio-voice/index.ts` — add `<Number>` for 2306 to the TwiML, enable AMD

### Database
- `call_logs` table — already has all needed columns. No schema change.

## Phasing

| Phase | Scope | Estimate |
|---|---|---|
| **1a** | Spec doc + branch + scaffolding | ~1 hour |
| **1b** | Add SDK dep + config plugin + native integration | ~half-day |
| **1c** | Outbound from mobile via Voice SDK | ~half-day |
| **1d** | Inbound on mobile (PushKit + CallKit + accept flow) | ~1 day |
| **2** | TwiML update for parallel 2306 ring + AMD | ~3 hours |
| **3** | (separate, gated on A2P approval) — swap SMS to Twilio | ~half-day |

Total Phase 1+2 ≈ 2.5 days of focused work.

## Risks

- **PushKit certificate** — Apple requires a separate VoIP services
  certificate beyond the regular APNs cert. Need to generate it in
  Apple Developer Portal and upload to Twilio. Process is well-trodden
  but adds 10-15 min of one-time setup.
- **AMD reliability** — Twilio's AMD is ~92% accurate by their own docs.
  If AMD misclassifies Nathan's voicemail as a human pickup ~8% of the
  time, calls would dead-end on his voicemail. Mitigation: combine AMD
  with a `<Gather>` "press 1 to accept" prompt on the 2306 leg. Adds
  one second of latency but eliminates the false-positive risk.
  *Decide before Phase 2 ships.*
- **CallKit incoming-call permissions** — iOS may show a permissions
  prompt the first time the app receives a VoIP push. Need to handle
  the case where user denies CallKit access (rare but possible).

## Open questions

- ~~Routing model — parallel vs sequential~~ → **Resolved: parallel (Option A)**
- AMD vs `<Gather>` press-1-to-accept for the 2306 leg → **decide before Phase 2**
- Do we want to show the call duration on the in-call screen, or just standard CallKit UI? → propose CallKit-only for V1, custom UI is overlay on top
- Should outbound from mobile fall back to the old bridge-callback flow if Voice SDK fails to connect? → **yes** for V1, keep `mobile/lib/dial.ts` as a fallback for ~2 weeks while we monitor reliability
