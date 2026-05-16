# Next Mobile Build — Feature Stack for TestFlight

**Current shipped build:** Build 6 (version 0.1.0) — icon + splash screen update only. Currently in Apple processing as of 2026-05-14.

**Next target build:** Build 7+ — the "dialer release"

Mobile builds are slow (1-2 hour total cycle: ~10min EAS build + ~10min ASC submit + ~5-60min Apple processing). Pattern: accumulate features on `main` between TestFlight builds, then build once with everything stacked. Native modules can't be hot-shipped via OTA — every Twilio Voice SDK / push-credential change requires a real TestFlight cycle.

## Why we're not using Expo Go

Expo Go is a dev-mode app that loads your JS bundle without compiling native code. **It can't run native modules** like Twilio Voice SDK, CallKit / PushKit, Apple's native push credential routing, etc. The dialer feature requires all of these. Every dialer iteration needs a real EAS build → TestFlight cycle.

(JS-only changes — pure React Native UI updates that don't touch native code — can ship instantly via `eas update --branch production` since we installed expo-updates during build 6. But dialer work is always native.)

---

## ✅ Features confirmed for next build

### 1. In-app dialer (Twilio Voice SDK) — `justin/mobile-dialer` branch
6 commits, ~600 lines of mobile + edge function changes.

- **Native scaffolding**
  - `mobile/lib/voice.ts` — Voice SDK wrapper
  - `mobile/plugins/with-twilio-voice.js` — Expo config plugin to inject native deps
  - `mobile/app/_layout.tsx` — Voice SDK wired into app launch
- **UI**
  - `mobile/app/call/[sid].tsx` — in-call screen (271 lines)
  - DTMF keypad
  - Add participant
  - Blind transfer
- **Push → answer flow** *(addresses the bug Justin hit 2026-05-14)*
  - Push notification arrives when 5440 number rings
  - Tap notification → opens app on the in-call screen → call is connected, NOT just app-opened-without-answering
  - This is the CallKit / PushKit integration on iOS
- **Server side**
  - `supabase/functions/twilio-token` — Voice grant now includes `push_credential_sid` so APNs routes calls correctly
  - `supabase/functions/twilio-voice` — minor changes for 2306 leg handling
- **Routing**
  - Parallel-ring option A (per `docs/IN_APP_DIALER_SPEC.md`)
  - AMD (answering-machine detection) for 2306 leg

### 2. expo-updates infrastructure *(auto-installed during build 6)*
Currently uncommitted in working tree (`mobile/package.json` +1 line, `mobile/package-lock.json` +119 lines, `mobile/app.json` +8 lines). The dialer branch also has these — when dialer merges, these come along.

After this lands, JS-only changes can ship via `eas update --branch production` without a full TestFlight cycle.

### 3. Add Nathan as TestFlight internal tester (admin-only, can be done anytime)

This is **NOT a build-time concern.** It's a one-time admin task in App Store Connect's web UI that's independent of which build is shipping. Once Nathan is added as an internal tester, he gets TestFlight notifications for ALL builds — past (Build 6 once it processes), present, and future. Do it whenever convenient — even right now while Build 6 is processing.

**Steps (Justin, since you have App Store Connect admin):**
1. Open https://appstoreconnect.apple.com/apps/6768752406/testflight/ios
2. Click **Internal Testing** in the left sidebar
3. Either:
   - Create a new internal group ("FundLocators Team") and add Nathan, OR
   - Add Nathan to the existing internal group if one exists
4. Nathan must already be a user on the Apple Developer team (Apple ID needs to be invited as a developer first if not already). For `racin2701@yahoo.com` team `8RJDH7L35Q`, check existing users in App Store Connect → Users and Access.
5. Nathan gets an email invite → installs TestFlight on his iPhone → signs in → sees DCC available

### 4. Mobile UI: render inbound media images in comms thread

**Backend already done (5/13):** receive-sms edge fn v51 + bridge.js both extract MMS / iMessage attachments and store the URL in `messages_outbound.media_url`. Public bucket `inbound-media` is live. **Web UI already renders.**

**Mobile gap:** `mobile/app/deal/[id].tsx` line 172-173 queries `messages_outbound` but selects only `id, direction, body, status, thread_key, created_at` — drops `media_url`. Zero `<Image>` components in the mobile codebase reference it. Result: images that arrive via MMS show up as text-only rows on the phone.

**The fix** (~30 lines):
- Add `media_url` to the SELECT
- Add `media_url` to the local TypeScript message type
- In the message-rendering JSX, conditionally render `<Image source={{uri: m.media_url}} style={{...}} />` when present
- MIME-sniff via filename regex (same pattern as `src/app.jsx` lines 21901-21915) for image vs video vs generic attachment
- Optional polish: tap → lightbox via `expo-image-viewing` or similar

## 🤔 Other candidates — confirm or drop

- **Anything from Justin's other Claude session "with notifications"** that started this list. **Session search is currently blocked** (tool requires interactive mode not available to background sessions) — paste the items here and I'll merge.
- **Anything Nathan's session has been building** that's mobile-side. WORKING_ON.md shows Nathan's last mobile-related entry was 5/8 (server-side bug fixes, not mobile), so nothing obvious — but worth a `git pull` + skim before locking.

## Pre-build checklist

- [ ] Rebase `justin/mobile-dialer` onto current `main`
  - **Conflicts expected:** icon files (the branch was forked before icons were updated — the branch's PNGs are old placeholders, main has the orange crosshair); preserve main's icons during rebase
  - **Possible conflict:** `OutreachDraftPanel.tsx` deletion on the branch may conflict if something on main has touched it
  - **Possible conflict:** CLAUDE.md, WORKING_ON.md, session-coordination files (the branch is older than Nathan's session-ritual additions)
- [ ] Run `cd mobile && npm install` after rebase to make sure dependencies match the lockfile
- [ ] Smoke-test the dialer locally with `npx expo start` *(NOTE: Voice SDK won't work in Expo Go — need a dev-client build OR test directly in TestFlight after build ships)*
- [ ] Open PR for the rebased branch, merge to main
- [ ] Verify icons + splash are still correct on main after merge (`git show main:mobile/assets/icon.png | wc -c` should still be `562621`)
- [ ] In App Store Connect: add Nathan as internal tester (see §3 above) BEFORE the build, so when it processes he gets the email automatically
- [ ] Trigger build: `cd /Users/justinjohnson/Documents/deal-command-center/mobile && eas build --platform ios --profile production --non-interactive --auto-submit`
- [ ] Monitor — Claude can run the same `/tmp/eas-watch-and-submit.sh` pattern we used for build 6
- [ ] When TestFlight email arrives, install on both Justin's and Nathan's phones, test the dialer end-to-end:
  - Outside number → 5440 → push notification arrives → tap → call connected (not just app opened)
  - Outbound dial from in-app keypad → call connects
  - DTMF tones work mid-call (try ext entry on a voicemail menu)
  - Blind transfer mid-call works

## Build numbering

EAS auto-increments. Build 6 was today's icon build. Next build will be Build 7. The `mobile/eas.json` has `autoIncrement: true` on both preview and production profiles so we don't have to manually bump.

## When this build is done

Archive this file (move to `docs/archive/NEXT_MOBILE_BUILD_2026-05-14.md` or similar) and start a fresh list for the build after.
