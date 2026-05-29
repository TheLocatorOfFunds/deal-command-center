# DCC Mobile - Pre-Build QA Protocol

**Run this gate before every `eas build`. Never trigger a cloud build on static code reading alone.**

## Why this file exists

An EAS build costs money per build, and Apple's processing adds several
hours of wait before you find out it is broken. So a broken build is
expensive twice: the build credit AND the hours lost waiting on Apple.

Every check below exists because we shipped a broken build on that exact
failure mode at least once (build numbers cited). The whole point of the
gate is to catch these locally, in seconds, for free, BEFORE spending a
build credit and a Apple processing cycle.

The runnable version of this checklist is the `mobile-prebuild-gate`
skill. Invoke it and it runs every mechanical check below and returns a
GO / NO-GO verdict with evidence. This doc is the human-readable why.

---

## The gate (cheapest checks first, fail fast)

### Phase 0 - Branch & diff sanity  (the Build 14 catastrophe)
The single most expensive failure: building from the wrong branch state,
so the feature ships as a complete no-op.

- `git branch --show-current` matches the branch you intend to build from
- For EVERY file you believe you changed: `git diff <base>..HEAD -- <file>`
  shows a real diff. An empty diff on a file that should have changed means
  you are on the wrong branch. STOP.
- Build number is read, never guessed: check `app.json` `ios.buildNumber`
  and `eas build:list --platform ios --limit 1`.

> Build 14 verbatim feedback: "How in the hell did you miss the very thing
> that we were putting out?" Cause: code written in one worktree, build
> triggered from a different branch state.

### Phase 1 - Typecheck  (compile-breakers, the big money-saver)
- `cd mobile && npm run typecheck` (`tsc --noEmit`). ANY error = NO-GO.

A type error that breaks compilation would otherwise fail AFTER EAS spends
build minutes and you wait. This catches it in seconds, locally, free.

### Phase 2 - expo-doctor  (config / dependency drift)
- `cd mobile && npx expo-doctor`. Errors = NO-GO; warnings = review.

### Phase 3 - Entitlement guard  (the Builds 17-20 provisioning rejection)
- `app.json` entitlements MUST NOT contain
  `com.apple.developer.pushkit.unrestricted-voip`. It is not a registerable
  Apple capability; EAS cannot sync it and Xcode rejects the build.
- `app.json` entitlements MUST contain `aps-environment: production`.
- PushKit VoIP correctness lives OUTSIDE app.json:
  - `UIBackgroundModes: voip + audio` handled by the Twilio Expo plugin
  - VoIP Services cert created at developer.apple.com for `com.fundlocators.dcc`
  - That cert uploaded to Twilio console -> Voice -> Push Credentials
  - Without the cert, `didUpdatePushCredentials` never fires and every
    `voice.register()` fails with "Failed to initialize PushKit device token."

### Phase 4 - SDK method & shape audit  (crashes that compile fine)
Grep changed files (`mobile/lib/voice.ts`, `mobile/app/call/[sid].tsx`,
anything touching the SDK) against the real type defs in
`node_modules/@twilio/voice-react-native-sdk/lib/typescript/*.d.ts`:

- `initializePushRegistry(` -> NO-GO. Does not exist. `new Voice()` creates
  the PKPushRegistry internally. (Build 14 crash on init.)
- `.getCustomParameters()` result used with `.get(` -> NO-GO. It returns a
  plain `Record<string,string>`, not a Map. Use bracket notation
  `params['dealId']`. (Build 15: `.get()` silently returns undefined,
  broke deal navigation.)
- Any new SDK method call -> confirm it exists in the `.d.ts` before shipping.

| Method | Returns | Note |
|---|---|---|
| `voice.register(token)` | `Promise<void>` | throws sync if PushKit token not ready; retry w/ backoff |
| `voice.getCallInvites()` | `Promise<ReadonlyMap<Uuid, CallInvite>>` | |
| `voice.getCalls()` | `Promise<ReadonlyMap<Uuid, Call>>` | |
| `callInvite.getCustomParameters()` | `Record<string,string>` | plain object - bracket notation only |
| `call.getCustomParameters()` | `Record<string,string>` | same |
| `initializePushRegistry()` | N/A | DOES NOT EXIST |

### Phase 5 - Lifecycle race audit  (Builds 16 & 17)
Heuristic greps; flag candidates for human eyeballing:

- `useEffect` that calls an async init (`initVoice`, `voice.register`) ->
  confirm an `_initInProgress`-style mutex exists. (Build 16: effect fired
  3x, concurrent `register()` collided.)
- `router.back()` near a disconnect / event handler -> confirm a
  `hangingUpRef`-style guard so user-hangup and the Disconnected event do
  not both pop the stack. (Build 17: double back landed user at tabs root.)
- Any loop that `break`s on a null check -> confirm an explicit
  `if (!voice) return` after the loop, not just an error-path guard.
  (Build 17: null `voice` after teardown mid-init dereferenced on retry.)

### Phase 6 - Post-build Supabase verification  (before ANY call testing)
After the build installs, before testing calls:

```sql
select build_number, status, error_message, created_at
from voice_sdk_status order by created_at desc limit 5;
```
`registered` + current build number = safe to test calls.
`failed` or missing = do not test calls, diagnose first.

---

## Build rules

- `eas build` only. NEVER `eas submit` without explicit per-build permission.
- EXPO_TOKEN lives in `~/.zshrc`.
- Profiles: `preview` and `production` both build store-distribution .ipa for
  TestFlight; `production` is the TestFlight default. `autoIncrement: true`
  bumps the build number per upload (`appVersionSource: remote`).
- Submit identity (from `eas.json`): ascAppId `6768752406`, teamId `8RJDH7L35Q`.

## NO-GO means STOP

If any hard check fails, do not trigger the build. Fix, re-run the gate,
then build. A 30-second local gate beats a multi-hour Apple round trip on a
build you already knew was broken.
