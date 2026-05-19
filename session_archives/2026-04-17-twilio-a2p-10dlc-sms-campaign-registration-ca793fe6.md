# Session 2026-04-17 — Twilio A2P 10DLC SMS campaign registration

**Owner:** Justin
**Source JSONL:** <source>
**Status:** DRAFT (auto-generated backfill, needs review)

## What we set out to do
Register a Twilio A2P 10DLC SMS campaign for FundLocators to legally send business text messages to Android users (iPhone users via iMessage bridge separately). The session started by deploying a Twilio Voice SDK browser calling feature built in a previous session, then pivoted to QUO research (user clarified previous recommendation was wrong), full comms architecture research, Twilio vs Telnyx decision, and culminated in completing the A2P campaign registration form in Twilio Console.

## Decisions made (durable — these change behavior going forward)
- **Comms architecture finalized**: iPhone users → iMessage via Mac bridge. Android users → Twilio SMS from dedicated Cincinnati business number (+1 513-951-8855). Browser calling → Twilio Voice SDK using the same Cincinnati number as caller ID (NOT Nathan's personal number as Verified Caller ID, which causes spam).
- **Twilio over Telnyx**: Twilio's `<Client>` + `<Number>` TwiML pattern natively supports simultaneous browser + iPhone ring. Telnyx requires SIP app on iPhone. Twilio chosen despite slightly higher spam baseline because implementation is simpler and Nathan's low call volume mitigates spam risk with proper Trust Hub + Voice Integrity enrollment.
- **No opt-out language in first message**: User willing to accept low filtering risk (<5%) for fully custom one-off texts. Carriers filter mass blasts, not conversational SMS.
- **A2P campaign use case: Customer Care ($10/mo)** — not Mixed. Framed as case status updates to signed clients with verbal consent during initial phone call. Pre-approved by carriers, no extra vetting.
- **Consent mechanism**: Verbal consent obtained during initial phone consultation, logged in CRM. No keyword opt-in (e.g., "Reply Y to opt in") — not needed for 1:1 conversational model.
- **Campaign description avoids "debt collection" framing**: Research confirmed surplus fund recovery is NOT debt collection under FDCPA (getting money FOR consumer, not FROM). Description uses clinical legal language: "government-held surplus funds," "tax lien sales," "foreclosure proceedings," "authorized representatives."

## Gotchas hit (non-obvious; future sessions need to know)
- **QUO (formerly OpenPhone) has NO browser SDK**: A previous session recommended porting Nathan's number to QUO for browser calling. This was wrong. QUO's API is read-only for calls; browser calling only works in QUO's own web app. User was frustrated: "This was all part of your plan." Required full pivot to Twilio.
- **iOS provides NO API for programmatic SMS from SIM**: All methods (Shortcuts, SMSMobileAPI) require per-message manual approval on iPhone. Mac bridge AppleScript SMS relay only works via Text Message Forwarding (requires iPhone on same WiFi/Bluetooth) — and that's broken on macOS 26 Tahoe beta. Android SMS MUST come from a VoIP number (Twilio), not Nathan's iPhone SIM.
- **Verified Caller ID = spam flag**: Using Nathan's personal mobile number as Twilio caller ID triggers spam analytics engines because the call displays a mobile number but originates from VoIP infrastructure. The mismatch (claimed number vs actual source) is a red flag for First Orion/Hiya/TNS. Solution: use a dedicated Twilio business number with CNAM + Voice Integrity registration (A attestation), not Verified Caller ID (B attestation).
- **Privacy policy URL is `/privacypolicy` not `/privacy-policy`**: Initial navigation to `/privacy-policy` 404'd. Actual URL discovered via JavaScript: `https://www.fundlocators.com/privacypolicy` (no hyphen). T&C URL is `/terms-and-conditions` (confirmed via browser check before submitting form).
- **Twilio account display name ≠ TCR brand name**: The Twilio Console shows brand as "My first Twilio account" (account nickname), but the actual TCR registration uses the legal business name from the Trust Hub Customer Profile (FundLocators LLC). Renaming the account display name to "FundLocators" (capital L, per user correction) is cosmetic; doesn't affect campaign approval.
- **Git rebase hell**: Local branch was 1 commit ahead but origin/main was 48 commits ahead. Required multiple `git stash` + `git rebase origin/main` cycles. After first rebase, 3 MORE commits appeared on origin (monitoring/Lauren changes). Had to rebase again. Retrieved new edge function files from stash via `git checkout stash@{0} -- supabase/functions/twilio-token/index.ts`. Calling feature edits re-applied fresh to 20k-line `src/app.jsx` rather than merging stashed version. Git worktree workflows don't survive heavy divergence well.
- **A2P sample messages MUST include opt-out**: Even though user doesn't want opt-out in actual first messages, Twilio form requires all sample messages to show "Reply STOP to opt out" — this is for carrier review, not actual message enforcement.

## Files / systems touched
- **Repo files:**
  - `src/app.jsx` — Added voice call state (callStatus, callContact, callDuration, incomingCall, callMuted, twilioDeviceRef, activeCallRef, callTimerRef), Twilio functions (initTwilioDevice, startCall, hangupCall, toggleMute, answerIncoming, rejectIncoming, fmtDuration), wrapped return in `<>` Fragment, green 📞 call button in thread header, incoming call overlay (bottom-right, Answer/Decline), active call overlay (live timer, Mute/End). Rebuilt app.js → 749.2 KB.
  - `index.html` — Added Twilio Voice SDK CDN after supabase-js: `<script src="https://media.twiliocdn.com/sdk/js/voice/v2.0/twilio.min.js"></script>`
  - `supabase/functions/twilio-token/index.ts` — NEW. Generates Twilio Access Token JWT using Web Crypto API (no npm deps). Identity: `dcc-browser`. 1-hour expiry. CORS headers.
  - `supabase/functions/twilio-voice-outbound/index.ts` — NEW. TwiML App Voice URL for browser-initiated outbound calls. Logs to call_logs, returns TwiML dialing destination with Nathan's number as callerId.
  - `supabase/functions/twilio-voice/index.ts` — Updated. Changed inbound TwiML to ring `<Client>dcc-browser</Client>` + `<Number>+15135162306</Number>` simultaneously.
  - `COMMS_PLAN.md` — NEW. Documents full comms architecture, Twilio setup checklist, 10DLC campaign framing, edge function URLs.
- **DB migrations:** None
- **Edge functions deployed:**
  - `twilio-token` (project: rcfaashkfpurkvtmsmeb)
  - `twilio-voice-outbound` (project: rcfaashkfpurkvtmsmeb)
  - `twilio-voice` (updated, project: rcfaashkfpurkvtmsmeb)
- **External systems:**
  - **Twilio Console:** Renamed account from "My first Twilio account" → "Fundlocators" → "FundLocators" (user corrected capitalization). A2P 10DLC campaign registration form completed — awaiting user confirmation to click "Confirm" ($15 one-time + $10/mo charge). Brand already registered (External Brand ID: BJ3MJD1, status: Registered, Private/Low Volume Standard).
  - **fundlocators.com/privacypolicy:** Verified contains required language: "No mobile information will be shared with third parties/affiliates for marketing/promotional purposes." + full SMS section (opt-in consent, message frequency, HELP/STOP, data rates).
  - **fundlocators.com/terms-and-conditions:** Verified URL exists before submitting to Twilio form.
  - **GitHub:** Pushed calling feature to main (commit includes app.js, index.html, src/app.jsx, supabase/functions/twilio-token, supabase/functions/twilio-voice-outbound, supabase/functions/tw