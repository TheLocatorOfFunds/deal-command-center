---
description: Ship mobile changes to Justin/Nathan's phones. Justin says the goal in plain English; YOU determine all git/build/OTA state yourself and execute. Never make Justin track branches or remember push order.
---

# /ship — get mobile changes onto the phone(s)

**Justin is not a developer.** He expresses intent in plain English:
- "put this on my phone" / "get this on my phone"
- "ship it to TestFlight" / "send it to Nathan"
- "is the latest stuff on my phone?"

YOUR job is to translate that intent into the correct git/build/OTA mechanics and
execute it. **Determine all state by checking it yourself — never ask Justin which
branch to use, whether to pull, whether it's an OTA or a build, what the build number
is, etc.** You have the tools (git, eas, supabase). Use them. Report outcomes in plain
English ("it's on your phone, force-quit the app twice" / "it's building, ~15 min").

This exists because the 2026-06-04 session put the branch-coordination burden on Justin,
which is backwards. He tracks goals; you track mechanics.

## Step 0 — figure out the current state (do this silently, never ask)

1. `git fetch --all`.
2. **Canonical mobile branch:** read the "Mobile build & branch flow" section of
   `CLAUDE.md`. As of this writing it's `justin/eas-preview-distribution-store` (interim,
   until issue #281 reconciliation), after which it becomes `main`. Re-check the doc —
   it is the source of truth, not your memory.
3. `eas build:list --platform ios --limit 3` — latest build + its gitCommit + channel.
4. EAS auth: the shell `EXPO_TOKEN` may be wrapped in literal angle brackets. Always run
   eas with `EXPO_TOKEN="${EXPO_TOKEN//[<>]/}"` and use the homebrew `eas`
   (`/opt/homebrew/bin/eas`), not `npx eas-cli@latest`.

## Step 1 — classify the change (JS-only vs native)

Check `git diff` against what's already shipped. **Native** if it touches: `mobile/app.json`,
`mobile/ios/`, `mobile/plugins/`, native deps in `mobile/package.json`, Info.plist,
entitlements, or adds/upgrades a native module. **Otherwise it's JS-only** (React
components, screens, lib logic, copy) → OTA.

When unsure, say so and lean toward a native build (safe default), but explain why in
plain English.

## Step 2a — OTA path (most changes; instant, no Apple, no build credit)

1. Be on the canonical branch; `git pull` it first (this is YOUR step, not Justin's).
2. `EXPO_TOKEN="${EXPO_TOKEN//[<>]/}" eas update --branch preview --platform ios --message "<plain summary>"`
   (channel `preview` → branch `preview`; confirm mapping with `eas channel:view preview`).
3. **Verify**: `eas update:list --branch preview` → the new group's commit == your HEAD.
4. **An OTA only reaches a build if published AFTER that build was built.** If the latest
   native build postdates your OTA, the OTA won't apply — say so and offer a fresh build.
5. Tell Justin: "It's on your phone. Force-quit DCC and reopen it twice — first reopen
   downloads it, second reopen loads it." Offer to verify via `call_logs` / a screenshot.

## Step 2b — native build path (only when native config changed, or for TestFlight)

1. **Run `/release-check inbound-callkit` first** (hook-enforced). NO-GO → stop and explain.
2. Be on canonical branch; `git pull`; confirm clean tree.
3. `eas build --profile <adhoc|preview> --platform ios` (adhoc = direct install;
   preview = TestFlight/store).
4. After it finishes: `eas build:list` → confirm the build's gitCommit == your HEAD.
   "Committed" is not "in the build."
5. **TestFlight submit requires Justin's explicit per-build permission.** With it:
   `eas submit`. Then `/release-check inbound-callkit --post` to confirm registration.
6. Report plain English: "Built Build N from your latest code. [Installing via the link /
   In TestFlight in ~10 min once Apple finishes processing]."

## Always

- **Verify with evidence**, never "should work": `call_logs`, `eas build:list`,
  `voice_sdk_status`. (See the QA + post-deploy-verification rules in CLAUDE.md.)
- **Report in plain English.** No branch names or git jargon unless Justin asks for it.
- **Never test-call/text a real client.** Test only to Justin's cell (+14797196859) or a
  confirmed Nathan/Google number.
- If two sessions might be building, you reconcile branches (you have the tools) — never
  ask Justin to remember which branch has what.
