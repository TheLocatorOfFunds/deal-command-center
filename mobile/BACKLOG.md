# DCC Mobile — Feature Backlog

Running list of things to build after v1 ships. Add ideas here instead of
starting them immediately. When we ask "what should we work on next?" pull
from this list.

Items marked **[DESIGN NEEDED]** need more thought before any code starts.
Items marked **[SHIPPED]** are merged — left in this doc so the history of
what we asked for is visible alongside what's still open.

---

## Notifications (big topic — needs design)

### App icon badge count
Show a numeric badge on the DCC app icon (the red dot with a number) driven
by unread notifications. Requires the app to track a "total unread" count
server-side so the badge updates even when the app is closed.

**Design questions:**
- What events increment the badge? (inbound SMS, docket events, team messages, deal activity?)
- Does anything NOT badge? (outbound confirmations, system events?)
- When does a badge clear — on open, or on explicit read?

**[DESIGN NEEDED]**

### Notification center (inbox)
When a user taps the badge or a notification banner, they need a clear path
to see ALL N pending notifications in one place, grouped by source. Something
like a notification feed / inbox screen that lists each event with enough
context to know what happened and where.

Each entry should deep-link directly to the relevant screen:
- Inbound SMS from a deal contact → opens that deal's Comms tab
- Docket event on a case → opens that deal's Intel/Docket tab
- Team message from Nathan or Eric → opens Team Chat
- Deal status change (if we ever push those) → opens deal detail

**Possible home for the icon:** calendar/activity icon top-right of the
header (already exists), or a dedicated bell icon. TBD.

**[DESIGN NEEDED]**

### Per-deal notification indicator
When a notification is tied to a deal, the deal card in the list should
show a visual indicator (unread dot, highlighted border, etc.) so it's
obvious which deals have something new without having to open each one.
Drilling into the deal should show WHICH tab the notification is on
(Comms, Docket, Activity, etc.) — not just that something happened.

**[DESIGN NEEDED]**

### Team chat notification badge
Bottom nav "Team" icon should show a badge when there are unread messages
in any team thread (Justin-Nathan DM, Ops channel, etc.).

Relates to the broader notification center — the same unread-tracking
system should drive both the app icon badge and the per-tab badges.

**[DESIGN NEEDED]**

---

## UX Polish

### Splash screen — hold 1 second longer
The splash screen currently dismisses too quickly. Add ~1 second of minimum
display time so it doesn't flash. Simple — just a `setTimeout` or
`SplashScreen.preventAutoHideAsync()` + manual hide after delay.

**Effort: small (< 30 min). No design needed.**

---

## Search

### Global search
Currently search only exists on the Deals tab. Consider a global search
accessible from anywhere in the app (persistent search icon in the header,
or a search tab in the bottom nav) that searches across deals, contacts,
and team messages in one place.

**Open question:** Is deal-only search actually fine for the use case?
Nathan and Justin mostly navigate by deal. Global search adds complexity
(mixed result types, ranking). May be premature. Revisit once the app
has more daily users.

**[DESIGN NEEDED — decide if this is actually worth it]**

---

## Comms / Messaging

### Voicemail playback on mobile deal screen **[SHIPPED]**
Done 2026-05-23. `mobile/app/deal/[id].tsx` now renders a "▶ Play
voicemail · 0:34" button on missed-inbound calls with a recording.
Uses `Linking.openURL(recording_url)` — hands off to iOS Safari /
the native audio sheet. No new dependency. The `twilio-recording`
EF is deployed `verify_jwt=false` so the proxy URL works without
auth headers (RE-prefixed Twilio SID is the access token).

Inline player upgrade (no app handoff) is a backlog follow-up —
needs `expo-audio` from SDK 53+.

### Voicemail-landed push notification **[SHIPPED]**
Done 2026-05-23. Closes the gap where the only inbound-call push
was at ring-time. New trigger
`tg_push_notify_voicemail_landed` fires "🎙 Voicemail from <caller>"
when `call_logs.recording_url` first populates on a missed inbound
call. data.type=voicemail so mobile can route distinctly from the
"📞 Incoming" ring push.

Migration: `supabase/migrations/20260523120000_push_notify_voicemail_landed.sql`.

### AI voice agent — Vapi integration (issue #210) **[CODE STAGED]**
Done 2026-05-23. Code on main, dormant until env vars are set in
Supabase. See the runbook posted on issue #210 for the dashboard
setup steps. Components shipped:
- Migration `20260523120100_call_logs_voice_intake.sql` —
  adds voice_provider / voice_call_id / voice_transcript /
  voice_summary / voice_intake / voice_cost_cents to call_logs.
- Migration `20260523120200_push_notify_agent_intake.sql` —
  trigger fires "🤖 Agent intake: <caller>" + topic when an intake
  lands.
- New EF `supabase/functions/vapi-webhook/index.ts` — receives
  end-of-call-report, verifies x-vapi-secret, stores
  transcript/summary/intake, resolves deal by caller phone,
  inserts activity row (or creates a lead if no deal match).
- New EF `supabase/functions/vapi-lookup-deal/index.ts` —
  Vapi-callable custom tool. Agent calls mid-conversation to
  personalize ("I see this is about case X in Y County").
- Modified `twilio-voice-status/index.ts` — missed inbound calls
  now redirect to Vapi if `VAPI_SIP_URI` env var is set;
  fall back to static voicemail otherwise. Existing voicemail
  behavior preserved when env var is missing — safe to deploy.

### SMS inbox + thread view + reply
Full two-way SMS surface on mobile. View inbound messages, send replies
from inside a deal. Currently deferred per v1 scope.

This is the next big surface after the dialer is solid.

**[DEFERRED — revisit after dialer is stable in TestFlight]**

### Team chat — feature parity with web **[SHIPPED]**
Justin/Nathan/Eric internal channel on mobile. Built out
2026-05-19. Implementation lives in
`mobile/app/team-thread/[id].tsx`.

Parity items now live on mobile:
- **Reactions** — long-press on a bubble opens an emoji picker (👍 ❤️
  😂 🎉 🔥 ✅ 👀 🤔). Tap an existing pill to toggle. Optimistic
  update + realtime sync via `team_reactions` table.
- **GIFs + images render inline** — was the priority bug. Storage-backed
  attachments re-sign via `team-chat` bucket signed URLs; Giphy
  attachments use the embedded `url`. Tap an image to open full-size
  in the system viewer.
- **Reply to a specific message** — long-press → Reply, composer
  shows quoted preview, reply bubbles render the parent body inline.
  Stored via `team_messages.parent_id` (schema has supported this
  since phase 1; web hasn't built it yet, so mobile leads).
- **@mentions** — composer detects `@<prefix>`, shows a picker of
  team profiles, inserts `@Name `. Plain-text storage, matches web.

Open follow-ups (not blocking — backlog them if they become real):
- Edit/delete a message from mobile (web has it; mobile doesn't).
- Image / file upload from mobile (mobile can render incoming images
  and send GIFs, but can't upload a photo from the camera roll yet —
  needs expo-image-picker + storage upload).

### Team chat — @mention push notifications **[SHIPPED]**
Done 2026-05-19 alongside the GIPHY picker. Postgres migration
`20260519130000_team_message_mention_pushes.sql` replaces
`tg_push_notify_team_message()` to:
- Scan the message body for `@<word>` tokens (regexp)
- Resolve each to a profile via case-insensitive prefix match on
  `display_name` or `name`
- Send a distinct "X mentioned you in #thread" push to mentioned
  users (data.type = `team_mention`)
- Subtract them from the generic thread recipients so they don't
  get double-pinged

Limitation: single-word names only. All current teammates (Nathan,
Justin, Eric, Anam) qualify. Multi-word names would need a
mentions[] column on team_messages.

### Team chat — GIPHY picker on mobile composer **[SHIPPED]**
Done 2026-05-19. `mobile/components/GifPicker.tsx` mirrors the web
`GifPickerPopover` — same GIPHY API key, trending on empty query,
debounced search, 3-col grid. Wired into the team-thread composer
via a 🎬 button next to the text input. Selected GIFs land in a
new `pendingAttachments` preview row and ship with the next send
inside `team_messages.attachments` (same shape the web app
produces, so AttachmentView round-trips them on both ends).

### Pull-to-refresh on chat + SMS threads **[SHIPPED]**
Done 2026-05-19. `RefreshControl` wired on both
`mobile/app/team-thread/[id].tsx` and `mobile/app/thread/[key].tsx`.
Pulling down on either thread re-fetches the messages list from
Supabase. The team-list view already had it.

### Join a video call from the mobile app **[SHIPPED]**
Done 2026-05-19. All four fixed rooms (Eric, Anam, Nathan,
Justin) now exist in both web and mobile. `mobile/lib/videoRooms.ts`
is the single source of truth — used by the Team tab roster and the
Jitsi-URL detection in both thread surfaces.

- Web room lists in `src/app.jsx` (the desktop sidebar at line ~3905
  and the mobile-popover at line ~28497) now include Nathan + Justin.
- Mobile Team tab (`mobile/app/(tabs)/team.tsx`) renders a Video
  Rooms bar with all four rooms. Tap → `Linking.openURL` hands off
  to the Jitsi Meet iOS app (or Safari if not installed).
- Both thread views (`team-thread/[id].tsx` and `thread/[key].tsx`)
  detect `meet.jit.si/...` URLs in message bodies and render a
  tappable "📹 Join video call" button.

Upgrade later to in-app WebView or the Jitsi React Native SDK if the
handoff feels janky — but `Linking.openURL` gives us full Jitsi
features (screen share, raise hand, audio routing) for zero
maintenance overhead.

---

## TestFlight

### Invite Nathan as internal tester
Nathan has an iPhone and needs to be on the same TestFlight builds as Justin.

Steps:
1. Log into App Store Connect (appstoreconnect.apple.com) with `racin2701@yahoo.com`
2. Go to the DCC app -> TestFlight -> Internal Testing
3. Add Nathan's Apple ID (need to confirm which email he uses for his Apple ID)
4. He'll get an email invite, accepts it, installs TestFlight app, installs DCC

Nathan's Apple ID email: **TBD - ask him.**

Once he's in, every new `eas submit --platform ios --latest` automatically
lands in his TestFlight. No manual steps per build after initial invite.

**Effort: 10 minutes once we have Nathan's Apple ID.**

---

## Dialer (already in progress)

### VoIP push cert → Twilio upload
`voip_services.cer` is in ~/Downloads. Needs to be uploaded to Twilio
console so PushKit delivery works for inbound calls.

**Action item, not a feature — do this now.**

### Deploy twilio-add-to-call + twilio-conference-twiml edge functions
Built but not deployed. Needed for conference/transfer from the DCC
call overlay.

**Action item, not a feature — do this now.**

---

## Notes / Principles

- Mobile is a thin, opinionated surface. It does 3-5 jobs well. It is NOT
  a clone of the web app on a phone.
- Notifications are the highest-leverage feature after the dialer — they
  are the reason to have the app on your phone at all.
- Before building any notification feature, design the full read/unread
  tracking system first. Bolting badge counts onto an app with no unread
  model produces a mess.
- Global search: only build it if there's a demonstrated need. A well-sorted
  deal list with a tab-level search may be sufficient.
