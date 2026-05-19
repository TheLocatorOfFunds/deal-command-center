# DCC Mobile — Feature Backlog

Running list of things to build after v1 ships. Add ideas here instead of
starting them immediately. When we ask "what should we work on next?" pull
from this list.

Items marked **[DESIGN NEEDED]** need more thought before any code starts.

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

### SMS inbox + thread view + reply
Full two-way SMS surface on mobile. View inbound messages, send replies
from inside a deal. Currently deferred per v1 scope.

This is the next big surface after the dialer is solid.

**[DEFERRED — revisit after dialer is stable in TestFlight]**

### Team chat — feature parity with web
Justin/Nathan/Eric internal channel on mobile. The mobile chat surface needs
to match the web app's team chat capabilities. Today the mobile surface is
read-mostly and missing the interactive bits below.

Parity checklist (must match web before we call mobile team chat "done"):
- **Reactions** — heart, thumbs up, like (and whatever emoji set the web app
  exposes). Tap-and-hold on a message to react, same as iMessage. Reaction
  counts visible inline.
- **GIFs + images render inline** — currently broken on mobile. Messages
  containing image/GIF attachments come through as text-only or blank. Need
  to fix the attachment rendering path so media displays in the thread.
- **Reply to a specific message** — threaded replies / quoted-reply UX so
  you can respond to a particular comment instead of always appending to
  the bottom of the channel.
- **@mentions / tag people** — typing `@` should show a picker of team
  members, insert the mention as a styled token, and notify the tagged
  user.

Bug to triage first: GIFs and images coming through Slack/web team chat
are not displaying on mobile right now — that's a regression to fix
before the rest of this work, since the data is already arriving.

**[DEFERRED — but parity list above is the spec when we pick it up]**

### Pull-to-refresh on chat + SMS threads
Pulling down on a team chat channel or an SMS thread should trigger a
refresh of the messages list (re-fetch latest from Supabase). Standard
iOS `RefreshControl` UX. Applies to both the team chat surface and the
deal Comms / inbound SMS thread view. Useful when realtime hasn't fired
yet or when returning to the app after backgrounding.

**Effort: small. No design needed.**

### Join a video call from the mobile app
When a team video call is happening (or a call invite is posted to a
deal chat), the mobile app needs a way to join it directly — tap a
banner / button in the chat and land in the call.

We already use **Jitsi** (`meet.jit.si`) on the web app — fixed rooms
like `https://meet.jit.si/DCC-Eric-Room` and `https://meet.jit.si/DCC-Anam-Room`,
plus per-deal rooms posted into chat as `📹 X started a video call: https://meet.jit.si/...`
(see `src/app.jsx:668, 3905-3906, 4033, 28497-28498`). Mobile should
reuse Jitsi — no new provider needed.

Implementation options:
- Simplest: detect the `meet.jit.si/...` URL in chat, open it in
  `Linking.openURL()` which hands off to the Jitsi Meet iOS app (or
  Safari if not installed).
- Better: open in an in-app WebView so the user doesn't leave DCC.
- Best: integrate the Jitsi Meet React Native SDK for a native call UX.

Start with `Linking.openURL()` for v1; upgrade later if the handoff
feels janky.

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
