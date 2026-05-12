# DCC Mobile — TestFlight metadata + runbook

Reference card for everything that goes into App Store Connect when we
ship DCC mobile to TestFlight (internal alpha first, eventually external
beta + public release).

## Identity

| Field | Value |
|---|---|
| App name (App Store Connect) | `DCC` |
| Subtitle (30 chars) | `Deal Command Center` |
| Bundle ID | `com.fundlocators.dcc` |
| SKU (for App Store Connect) | `dcc-mobile-001` |
| Primary language | English (U.S.) |
| Primary category | Business |
| Secondary category | Productivity |
| Apple Team ID | `8RJDH7L35Q` (Justin Johnson, Individual) |
| Owner Apple ID | `racin2701@yahoo.com` |

## TestFlight test info (internal testers — Justin/Nathan/Eric)

Internal testers get builds the moment they're processed. No Apple
review needed.

### Beta App Description (≤4000 chars)

```
DCC (Deal Command Center) is the companion mobile app for RefundLocators'
internal team. It mirrors the same Supabase data the web app uses so
you can drive surplus-fund case work from a phone — without needing the
laptop.

What's in this build:
• Inbox: unified SMS + call thread list across all deals, with realtime
  push notifications for inbound messages and calls
• Deals: full case detail — case intelligence briefing, sale facts
  (county, case #, surplus estimate, sale date), counsel, documents,
  docket events, tasks, notes, and a chronological comms timeline
• Lauren: AI chat about deals, synced with the web Ask Lauren panel
• Team chat: internal channel + DMs, synced with the web app
• Quick FAB: one-tap Call, Text, Note, Task, or New Deal
• Forecast: next 14 days of sheriff sales, hearings, and tasks
• Settings: notification preferences per event type (SMS / calls / team)

Calling goes through our FundLocators Twilio number so contacts see the
business as caller ID, not your personal cell.
```

### What to Test (≤4000 chars)

```
Priority test paths:
1. Sign in via magic-link email code on your phone
2. Tap a phone number from Deal Detail — your cell should ring from
   +15139985440, and answering should bridge you to the destination
3. Send an inbound SMS to the FundLocators number — you should get a
   push notification within ~2 seconds with sender name and preview
4. Tap a thread in Inbox, type a reply, send — confirm it lands at the
   recipient and the bubble shows the right status
5. Drill into a surplus deal — verify the Case Intelligence and Case
   Facts sections show real data, and tap-to-call buttons work
6. Ask Lauren about a specific deal — verify the response references
   actual case info
7. Post to the Team channel — confirm the other testers get a banner
8. Open the Forecast tab — verify upcoming sale dates appear

Known limitations in this build:
- No in-app dialer yet (Phase 2 work) — calls go through the Twilio
  bridge with a callback to your personal cell
- New deals must be created on the web for now (mobile create works but
  has minimal fields)
- App icon is a placeholder; final branding TBD
```

### Test Information

| Field | Value |
|---|---|
| First Name | Justin |
| Last Name | Johnson |
| Email | justin@fundlocators.com |
| Phone | (479) 719-6859 |
| Sign-in required | YES |
| Demo account (if used by reviewers) | nathan@fundlocators.com — magic-link auth, no password |

### Internal testers to add

| Name | Apple ID |
|---|---|
| Justin Johnson | racin2701@yahoo.com (already on team) |
| Nathan | nathan@fundlocators.com — needs to accept invite |
| Eric | eric@fundlocators.com — needs to accept invite |

Internal testers must accept an email invite from App Store Connect.
They install TestFlight from the App Store, then the build appears.

## App Store metadata (for public release, not TestFlight)

Not needed for internal TestFlight. Drafts here for when we go public.

### Promotional Text (170 chars)
```
The companion mobile app for RefundLocators' surplus-fund recovery team. Cases, comms, and AI in your pocket.
```

### Description (≤4000 chars)
```
[Same as Beta App Description above, plus a closing paragraph:]

DCC is built for the RefundLocators team and is not a public consumer
product. Access requires an active team account.
```

### Keywords (100 chars total, comma-separated)
```
crm,real estate,foreclosure,surplus,deals,calls,sms,team,sales,leads
```

### Support URL
```
https://app.refundlocators.com/support
```

### Marketing URL
```
https://refundlocators.com
```

### Privacy Policy URL
```
https://refundlocators.com/privacy
```
*(Required for App Store. Confirm this page exists before public release.)*

## App Privacy declarations (App Store Connect → App Privacy)

DCC collects the following data, all linked to user identity:

| Data type | Purpose |
|---|---|
| Email Address | Account auth (magic-link) |
| Phone Number | Twilio call bridge routing (the user's own cell) |
| Name | Profile display in team chat |
| Other Contact Info | Contacts linked to deals (homeowner phones, attorneys) |
| Contacts | Per-deal vendor / counsel info — used for app functionality |
| User Content (messages) | SMS threads, team chat, notes — used for app functionality |
| Identifiers (User ID) | Supabase auth.uid for RLS scoping |
| Diagnostics (Crash data) | Via Expo's standard diagnostic surface |

**No data is shared with third parties** beyond:
- Twilio (for the SMS / voice bridge — user-initiated)
- Supabase (the backing database, our infrastructure)
- Anthropic (Lauren AI — only on user-initiated chat)

## Release plan

### Phase A — Internal TestFlight (THIS PR)
1. `eas build --platform ios --profile preview` → builds release-mode .ipa
2. `eas submit --platform ios --latest` → uploads to App Store Connect
   - **First submit auto-creates the app in App Store Connect**
   - Capture the assigned **ASC App ID** and update `eas.json` submit
     profiles with it (so future submits don't need to look it up)
3. In App Store Connect → TestFlight tab:
   - Fill out Test Information section (copy from above)
   - Add internal testers (Nathan, Eric)
4. They get invite emails → install TestFlight → DCC build appears

### Phase B — External TestFlight (after internal works)
1. Create a TestFlight group (e.g. "Surplus team external")
2. Submit Beta App Description for Apple Beta App Review (~24-48hr)
3. Once approved, share TestFlight public link or email invites

### Phase C — Public App Store
Probably never. DCC is internal tooling, not a consumer product. If we
ever do this, the App Store metadata draft above is the starting point.

## Versioning

- `app.json` version = the human-visible version (`0.1.0`)
- `app.json` `ios.buildNumber` = auto-incremented by EAS on each
  production build (set via `autoIncrement: true` in eas.json)
- For preview/TestFlight builds, EAS bumps the build number per upload
- For the App Store version, bump the `version` string when shipping a
  new release

## Renewal reminders

- Apple Developer Program: renews **May 11, 2027** ($99/yr, auto-renew ON
  but warning shown — add a card to ensure no lapse)
- iOS Distribution Certificate: expires **May 12, 2027**
- iOS Provisioning Profile: expires **May 12, 2027**

Calendar these now: Apple will auto-renew the cert + profile if EAS
manages them and the Dev Program is current. But if the Dev Program
lapses, builds stop working immediately.
