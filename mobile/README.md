# DCC Mobile — companion iOS/Android app for Deal Command Center

React Native + Expo (managed workflow) app that hits the same Supabase
project as the web app at `src/app.jsx`. Auth, RLS, and data model are
shared. Mobile is intentionally a thinner surface that does 3-5 jobs
really well — see `memory/mobile_app_plan.md` for v1 scope and out-of-scope
list.

## First-time setup

```bash
cd mobile
npm install                            # one-time
npx expo install --check               # reconcile any peer-dep drift
```

If you don't already have it:

```bash
npm install -g eas-cli                 # for builds + TestFlight submits
eas login                              # use justin@fundlocators.com
```

## Local dev

```bash
npx expo start                         # opens Metro bundler
# press 'i' for iOS simulator (requires Xcode)
# press 'a' for Android emulator
# scan the QR code with Expo Go on a physical phone
```

For the magic-link sign-in to come back to the running app, the device
needs to have the same Wi-Fi as your dev machine, or you need to be using
Expo Go via tunnel mode (`npx expo start --tunnel`).

## TestFlight build (internal alpha)

```bash
eas build --platform ios --profile preview
# wait ~10-15 minutes for EAS to build + sign
eas submit --platform ios --latest
# wait ~10-30 minutes for App Store Connect processing
```

After the build is processed, go to App Store Connect → TestFlight, add
internal testers (Justin, Nathan, Eric), they get an email invite, install
TestFlight from the App Store, and the build appears.

## Project structure

```
mobile/
├── app/                       # expo-router file-based routes
│   ├── _layout.tsx            # root layout + AuthProvider + protected routing
│   ├── (auth)/
│   │   └── sign-in.tsx        # magic-link sign-in
│   └── (tabs)/
│       ├── _layout.tsx        # bottom tab navigator
│       └── index.tsx          # Today screen (first real DCC view)
├── lib/
│   ├── supabase.ts            # client — same URL + publishable key as web
│   └── auth.tsx               # React Context exposing the session
├── assets/                    # icons + splash (TBD)
├── app.json                   # bundle id `com.fundlocators.dcc`, scheme `dcc://`
├── eas.json                   # build profiles: development / preview / production
├── package.json
└── tsconfig.json              # strict TS, paths alias `@/*`
```

## Stack

- **Expo SDK 52** (managed workflow) — no Xcode/Android Studio required
  for daily work, only for native plugins
- **expo-router 4** — file-based routing modeled on Next.js
- **TypeScript** strict mode
- **@supabase/supabase-js** — same client as web; AsyncStorage for session
  persistence

## Conventions

- Same Supabase project as web. Never put the service-role key here —
  publishable key only.
- Auth: `signInWithOtp` magic link, no passwords.
- Style: dark theme to match DCC's web aesthetic (charcoal background,
  orange accent `#d97706`).
- Don't import the web app's React tree directly. Mobile and web share
  the data model but not the UI — phone-sized layouts only.

## What's NOT in this scaffold yet

- App icon / splash screen (TBD — Justin/Nathan to provide)
- Push notifications (post-v1)
- Deals list / Comms thread / drop voicemail screens (v1 scope still TBD
  pending Justin + Nathan's decision on which views ship first)
- EAS app credentials (set during first `eas build` — EAS prompts you)
- App Store Connect app entry (created during first `eas submit`)

## Domain ownership

Per `CLAUDE.md`'s table, mobile is currently **Justin's domain**. Touch
with care from other sessions.
