# DCC Mobile - Pre-Build QA Protocol

Run every step in this file before triggering `eas build`. No skipping.
The checklist was built from post-mortems on Builds 14-17 (May 2026).

---

## Phase 1 - Code verification (run before `eas build`)

### 1.1 Confirm the code is actually on the branch

The single most common failure mode: code written in one worktree/session,
build triggered from another, feature ships as a no-op.

```bash
# From the build worktree root
git diff HEAD -- <every file that was supposed to change>
git log --oneline origin/main..HEAD
```

Every file you touched must show up in the diff. If a file you edited shows
no diff, you are on the wrong branch or your changes weren't committed.

### 1.2 Verify every SDK method actually exists

Before using any SDK method, confirm it exists in the type definitions:

```bash
grep -r "methodName" node_modules/@twilio/voice-react-native-sdk/lib/
```

**Known SDK gotchas (voice-react-native-sdk):**
- `initializePushRegistry()` - DOES NOT EXIST. Removed in newer versions.
  `new Voice()` creates the internal PKPushRegistry automatically.
- `callInvite.getCustomParameters()` - returns `Record<string, string>`,
  NOT a `ReadonlyMap`. Use bracket notation `params['key']`, not `.get('key')`.
- `callInvite.getCallSid()` - exists, returns `string`.
- `voice.getCallInvites()` - returns `Promise<ReadonlyMap<Uuid, CallInvite>>`.
  Iterate with `for (const [, invite] of pending)`.
- `voice.getCalls()` - returns `Promise<ReadonlyMap<Uuid, Call>>`.

### 1.3 Check for null dereference after async sleeps

Pattern to scan for: `await sleep(...)` or any `await` inside a loop
where shared singleton state (like `voice`) could be nulled by a concurrent
path (like `teardownVoice()`) while you were sleeping.

After every sleep/await in a retry loop, the next line that uses shared state
needs a null guard:

```typescript
// WRONG
for (const wait of delays) {
  if (wait > 0) await sleep(wait) // teardown could run here
  await voice.register(token)     // voice might be null now - CRASH
}

// RIGHT
for (const wait of delays) {
  if (wait > 0) await sleep(wait)
  if (!voice) break               // guard before every use after sleep
  await voice.register(token)
}
// ALSO add guard after the loop exits - break with lastErr=null is a trap:
if (!voice) return false          // teardown nulled voice, don't proceed
```

### 1.4 Check for double navigation

Any place where a user action AND an SDK event both fire on the same gesture
can produce two `router.push/back` calls. Audit every navigation call:

- Does a user-initiated action (e.g. tap End) call `router.back()`?
- Does the SDK event triggered by that same action (e.g. `Call.Event.Disconnected`)
  also call or schedule `router.back()`?

Fix pattern: `useRef(false)` flag set before the user-action navigation,
checked inside the event-driven navigation to skip it.

Build 17 example: `hangUp()` called `router.back()` AND `onDisconnected`
scheduled a second `router.back()` 1.2s later. First dismissed call modal,
second popped the deal page - user landed at tabs root.

### 1.5 Check every `useEffect` dep array for concurrent-init risk

For any `useEffect` that calls an async init function, ask:
"What if this dep array fires 2-3 times in rapid succession during auth
resolution?" (`[loading, session]` is the common culprit.)

- Does the init function have a mutex (`_initInProgress` flag)?
- Does the cleanup path (`return () => teardown()`) properly reset state?
- If the cleanup fires while the init is mid-flight (mid-sleep), does
  the init detect the teardown and abort cleanly?

Build 16 root cause: `[loading, session]` fired 3x during auth, producing
3 concurrent `voice.register()` calls. SDK rejected with "Registration in
progress" collision errors.

### 1.6 Check every `obj.on(event, handler)` for cleanup

Every event listener registered with `.on()` must have a corresponding
`.off()` in the useEffect cleanup return function. Missing `.off()` means
the handler survives component unmounts and fires against stale state.

### 1.7 Check for stale branch state in WORKING_ON.md

```bash
git pull  # or: git log HEAD..origin/main
```

Never write to WORKING_ON.md asserting current state without pulling first.

---

## Phase 2 - Build trigger

```bash
cd mobile
EXPO_TOKEN=<token> eas build --platform ios --profile production --non-interactive
```

Confirm the build output shows the correct commit SHA matching the HEAD of
your working branch.

After the build completes, verify:
```bash
eas build:list --platform ios --limit 1
```
- Status: `finished`
- Build number: incremented from last build
- Commit: matches `git rev-parse HEAD`

---

## Phase 3 - TestFlight QA steps (in order, no skipping)

Do not submit to App Store Connect until **Step 1** passes. If Step 1 fails,
the device is not registered with Twilio and everything below it will fail too.

### Step 1 - SDK registration check (BLOCKING)

After installing the build and launching the app, wait 15 seconds, then
query Supabase `voice_sdk_status`:

```sql
select build_number, status, error_message, created_at
from voice_sdk_status
order by created_at desc
limit 5;
```

- Expected: a `registered` row with the current build number, recent timestamp.
- If `failed`: read `error_message`, diagnose before proceeding.
- If missing entirely: voice.ts init returned false before writing. Check logs.

**Do not test inbound calls until this shows `registered`.**

### Step 2 - Inbound call receipt + accept

Call +15139985440 from an external number. Expected:
- CallKit native UI rings on the device
- Accept the call
- App navigates to the associated deal (if dealId in custom params)
- Call screen modal opens on top of the deal
- Call state shows "Connecting..." then "Connected" with timer

### Step 3 - End tap (tests double-back fix)

While on the test call, tap End. Expected:
- Call screen dismisses immediately
- App lands on the DEAL page (not the tabs root, not home)

If the app goes all the way back to tabs: the `hangingUpRef` fix is missing
or not working. Two `router.back()` calls fired.

### Step 4 - Remote hang-up

Call in, accept, then have the caller hang up. Expected:
- Call screen briefly shows "Ended"
- Modal auto-dismisses after ~1.2 seconds
- App lands on the deal page

### Step 5 - Speaker + mute

During a live call:
- Tap Speaker: audio should route to speakerphone, button highlights
- Tap Speaker again: back to earpiece
- Tap Mute: caller can't hear you, button highlights
- Tap Mute again: unmuted

### Step 6 - Dynamic Island / green pill tap

While on an active call:
- Press Home (app goes to background, green pill appears at top)
- Tap the green pill
- App should come to foreground and open directly to the call screen

### Step 7 - Outbound quick dial

From the app: Quick Action > Call. Search a contact or dial directly. Expected:
- If Voice SDK is initialized: goes directly to the in-call screen (no bridge alert)
- If Voice SDK failed init: falls back to bridge alert ("Your cell will ring...")

### Step 8 - Cold launch while call is pending

Kill the app completely. Have someone call +15139985440. Expected:
- PushKit wakes the app in the background
- CallKit shows native incoming call UI
- Accept via CallKit
- App opens to deal + call screen

Note: if the user accepts within ~1.5s of the cold launch, the Dynamic Island
handler on the next foreground transition is the safety net for navigation.

---

## Appendix - Known architecture constraints

| Constraint | Why |
|---|---|
| `newArchEnabled: false` in app.json | Twilio Voice SDK not compatible with React Native new arch as of SDK v1.x |
| EAS build profile `production` for TestFlight | `preview` profile requires internal distribution; `production` is the store profile that works with TestFlight |
| `eas submit` requires explicit permission | Justin's rule: never auto-submit to App Store Connect |
| Twilio test number: +15139985440 | A2P 10DLC verified. Do NOT use real client numbers for test calls |
