# DCC Mobile — v1 plan (locked 2026-05-11)

The mobile app is intentionally a **thin surface** over the same Supabase
data the web app uses. Same auth, same RLS, same data model. NOT a clone
of DCC web — phone-sized, opinionated, does 3-5 jobs really well.

## The 5 jobs (locked)

1. **Deal list** — recent deals, sorted by updated_at
2. **Deal detail** — phone-sized read-only view of one deal: status,
   address, claimant, attorney, contact phones, recent activity
3. **Tap phone → dial** — outbound calls from inside a deal
   - Expo Go phase: `Linking.openURL('tel:...')` (native dialer, no DCC branding)
   - EAS dev build phase: Twilio Voice + react-native-callkeep (in-app
     dialer with CallKit, case context visible mid-call, calls auto-log
     to `activity`)
4. **Incoming call → auto-open matching deal** (dev build only —
   impossible in Expo Go because Expo Go can't receive VoIP push or
   register CallKit handlers)
   - Caller phone hits Twilio number → VoIP push wakes the app → app
     looks up the number against `contacts` / `vendors` /
     `personalized_links` / `messages_outbound` → CallKit shows
     "Incoming: {claimant name} · {deal id}" → answer →
     auto-navigate to deal detail
5. **Sign in** — magic-link / 6-or-8-digit OTP code (already shipped)
6. **Push notifications** — fire on three events:
   - **Inbound SMS** lands in `messages_outbound` (`direction='inbound'`)
   - **Incoming call** to the Twilio business number (via Twilio
     StatusCallback hitting an Edge Function)
   - **Team chat message** posted by another member (Justin/Nathan/Eric)
   Phase 1 (Expo Go) uses Expo Push Service (token via
   `expo-notifications`, server-side push via Expo's HTTP API).
   Phase 2 (EAS dev build) can switch to direct APNs if/when the
   reliability of Expo Push becomes a problem. Tokens stored on
   `profiles.expo_push_token` (new column).

## Explicitly deferred (NOT in v1)

- SMS Inbox + Thread view + send/reply
- Team chat (Justin/Nathan/Eric internal channel)
- Lauren (pgvector AI) chat
- Push notifications for non-call events
- Pipeline kanban / expenses / reports / analytics / library
- Anything resembling GoHighLevel's automations UI

The texting surface gets revisited after the dialer is working in TestFlight.

## Stack decisions (locked)

| Choice | Why |
|---|---|
| **Expo SDK 54 (managed workflow)** | Matches Expo Go on the App Store; new arch ready |
| **expo-router 6 (file-based)** | Same mental model as Next.js; typed routes |
| **TypeScript strict** | Cheap insurance |
| **@supabase/supabase-js + AsyncStorage** | Same client as web; persistent session |
| **EAS Build + TestFlight** | Easiest path to a real iOS install |
| **Twilio Voice** | NEW Twilio product line for this app — not the SMS infra (which on web goes via Nathan's iPhone via mac_bridge). Voice doesn't need the bridge. |
| **react-native-callkeep** | iOS CallKit for native incoming-call UI |
| **Bundle id `com.fundlocators.dcc`** | Match the LLC; no rename later |
| **Deep-link scheme `dcc://`** | For magic-link redirect in TestFlight |

## Phase plan

### Phase 1 — Expo Go (week of May 11)
Goal: prove the daily-driver flow works on Justin's actual iPhone.

- ✅ Auth (magic-link with 6/8-digit OTP code entry)
- ✅ Deal list
- 🔲 Deal detail (tap card → drill in)
- 🔲 Phone-tap → `tel:` deep-link to native dialer (placeholder for Twilio Voice)

### Phase 2 — EAS dev build (after Apple Developer enrollment approved, ≤48hr)
Goal: replace the `tel:` placeholder with Twilio Voice + add inbound calls.

- 🔲 First `eas build --platform ios --profile development`
- 🔲 Install dev build on Justin's iPhone (via download link)
- 🔲 Add `@twilio/voice-react-native-sdk` + `react-native-callkeep`
- 🔲 Twilio Voice TwiML app + access-token edge function
- 🔲 Outbound: tap phone in deal detail → Twilio call, CallKit screen shows deal context
- 🔲 Inbound: incoming call to Twilio number → VoIP push → app wakes → lookup caller phone → CallKit "Incoming: {claimant} · {deal}" → answer → navigate to deal detail
- 🔲 VoIP push notifications via Apple Push Notification service

### Phase 3 — TestFlight (after Phase 2 is rock solid)
Goal: Nathan + Eric on the same build.

- 🔲 `eas build --platform ios --profile preview`
- 🔲 `eas submit --platform ios --latest`
- 🔲 Internal testers added in App Store Connect
- 🔲 Justin/Nathan/Eric install via TestFlight

## Anti-patterns to avoid

- **Don't import the web app's React tree.** Mobile + web share data, NOT UI.
- **Don't use the service-role Supabase key.** Publishable key only; RLS does the work.
- **Don't extend the legacy Twilio outbound path for SMS.** Per CLAUDE.md, all outbound SMS goes through the Mac bridge / Nathan's iPhone. Voice is the exception because it's a different Twilio product and the bridge doesn't do voice.
- **Don't try to make incoming-call → deal-open work in Expo Go.** It can't. Save that work for the dev build.
- **Don't over-engineer auth.** OTP code entry is bulletproof and works everywhere; magic-link deep-links are a redirect-allowlist nightmare in Expo Go.

## Cost summary

- Apple Developer Program: $99/year (paid May 11 2026, order #W1863932559)
- EAS Build: free tier (30 builds/month) sufficient for v1
- Twilio Voice: ~$0.013/min outbound US, ~$0.0085/min inbound
- Supabase: same project, no additional cost

## Domain ownership

Per `CLAUDE.md`'s table, mobile is **Justin's domain**. Other Claude
sessions should not touch `mobile/` without coordinating.
