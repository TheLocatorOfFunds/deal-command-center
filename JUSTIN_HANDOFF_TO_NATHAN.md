# Justin → Nathan handoff — everything I've built on DCC

**Date compiled:** 2026-07-01
**By:** Justin's Claude Code session (worktree `vigorous-williamson-f7809f`)
**For:** Nathan's next Claude Code session
**Repo:** `~/Documents/Claude/deal-command-center/` (or `~/Documents/deal-command-center/`)
**Live site:** [app.refundlocators.com](https://app.refundlocators.com) (GitHub Pages, `main` branch = live)
**Mobile app:** `mobile/` directory (Expo/React Native, EAS builds → TestFlight)

---

## How to read this doc

This is a single-file handoff of everything I've built on DCC between **2026-04-17** and **2026-07-01**. Nathan (or Nathan's Claude session) can drop this into their working memory and pick up where I left off without re-deriving 2.5 months of context.

The organizing principle: **what I own → what shipped → where it lives → what's open → gotchas that will bite you.**

For durable reference:
- **`CLAUDE.md`** at repo root = architecture + team-shared rules
- **`CLAUDE.local.md`** = Justin's personal rules (gitignored; ships this file to Nathan so he can decide what to promote)
- **`WORKING_ON.md`** = live cross-session state; check the "Justin's session" section
- **`session_archives/`** = per-session durable learnings (12 Justin-authored entries; index at `session_archives/index.md`)
- **`memory/`** at `~/.claude/projects/-Users-justinjohnson-Documents-deal-command-center/memory/` = my long-term personal notes (26 files)
- **`DIRECTOR_DCC_INTERFACE.md`** = intel-main ↔ DCC contract

---

## 1. My domain map (what I own vs. what Nathan owns)

Per the ownership table in `CLAUDE.md`:

| Domain | Owner | Key files / tables |
|---|---|---|
| **SMS / Twilio outbound + inbound** | Justin | `messages_outbound`, `phone_numbers`, `send-sms`, `receive-sms` EFs |
| **iMessage bridge (Mac Mini daemon)** | Justin | `mac-bridge/bridge.js`, runs on defender-mini via `DCCBridge.app` Login Item |
| **DCC Mobile companion app** | Justin | `mobile/` — Expo + React Native + Twilio Voice SDK; TestFlight distribution |
| **Voice — inbound + outbound + CallKit** | Justin | `twilio-voice`, `twilio-voice-outbound`, `twilio-voice-status`, `twilio-voice-screen`, `twilio-token`, `mobile-place-call` EFs; `call_logs` table |
| **Automations / Outreach / Relay** | Justin | `outreach_queue`, `relay_enrollments`, `send-sms`, cadence engine |
| **Payroll** | Justin | `time_entries`, `payroll_reminders`, `send-payroll-reminder` EF |
| **e-signatures (eSignatures.com pilot)** | Justin | `esignatures_contracts`, `send-esignature-contract`, `esignatures-webhook` EFs |
| Client portal | Nathan | `portal.html`, `client_access` |
| Attorney/counsel portal | Nathan | `attorney-portal.html`, `attorney_assignments` |
| Castle / docket integration | Nathan | `docket_events`, `docket_events_unmatched`, `scrape_runs`, `docket-webhook` |
| Email / Resend triggers | Nathan | `messages_email_notify`, `docket_events_client_notify`, `morning-sweep` |
| Lead intake + dup detection | Nathan | `lead-intake.html`, `leads`, `find_lead_duplicates` |
| Phase 3 Library | Nathan | `library_documents`, `library_folders`, `deal_library_pins` |
| Lauren / pgvector AI chat | **co-owned** | `lauren_*` tables, pgvector embeddings |
| Shared surfaces | Both | `deals`, `vendors`, `tasks`, `expenses`, `activity`, `deal_notes`, `documents`, `contacts`, `contact_deals`, `index.html` shell, nav, shared components |

**Rule of thumb:** if you (Nathan's Claude session) are about to touch something in Justin's column, post a note in `WORKING_ON.md` first and wait.

---

## 2. What shipped, by month

<!-- Session archive summary goes here — 12 Justin-authored archives -->

### 2026-04 (setup + comms architecture)

**2026-04-17 · Twilio A2P 10DLC SMS + browser calling scaffolded**
- Browser-based Twilio Voice SDK integrated into `src/app.jsx` — green 📞 call button, incoming overlay, live timer, hangup/mute controls.
- NEW edge functions: `twilio-token` (Access Token JWT via Web Crypto API, identity `dcc-browser`, 1-hour expiry), `twilio-voice-outbound` (TwiML App Voice URL for browser outbound), updated `twilio-voice` (inbound rings `<Client>dcc-browser</Client>` + Nathan's `+15135162306` in parallel).
- `index.html` loads Twilio Voice SDK v2.0 from CDN.
- A2P 10DLC campaign form submitted (Customer Care use case, $10/mo, $15 one-time).
- Full doc: [`session_archives/2026-04-17-twilio-a2p-10dlc-sms-campaign-registration-ca793fe6.md`](session_archives/2026-04-17-twilio-a2p-10dlc-sms-campaign-registration-ca793fe6.md).

**2026-04-23 · Facebook marketing assets for flip-2533**
- 6 hero tiles + 10 property photos in `~/Desktop/2533_FB_Post/`. Not a repo deliverable — reference for future flip listings.

**2026-04-29 · FB group posting workflow**
- Documented in-group duplicate search + `/about` rule check pre-post protocol.
- Encoded to `memory/feedback_fb_group_posting.md`.

**2026-04-30 · A2P + Quo + iMessage architecture decided**
- 8 PRs merged (#20–#28): Twilio number hidden from operator-facing selectors where inappropriate; Lauren "rooms" removed (both "loop X in" + "tell X" now post to existing Justin↔Nathan DM); `verify_jwt = false` pinned in `supabase/config.toml` for lauren-team-respond (survives redeploys — was toggling back to true on every deploy).
- Mac bridge stays primary SMS (blue bubbles + no opt-out per Apple); Twilio backs Android. Quo held for voice-only.
- Docs: `docs/MAC_BRIDGE_RECOVERY.md`, `docs/A2P_10DLC_REGISTRATION.md`.

### 2026-05 (Twilio A2P live + payroll + mobile + comms hardening)

**2026-05-01 · Texting stack + Quo port + session-archive backfill**
- Quo port to `+15135162306` completed (Spectrum cellular deactivated post-port — iMessage continued via Apple ID, but SMS relay required new cellular line or second device).
- macOS Tahoe upgrade broke Mac→iPhone SMS relay (error 4, no workaround — Apple upstream bug). Documented at `mac-bridge/bridge.js:44-48`.
- Session-archives backfill infrastructure: `scripts/backfill_session_archives.py` walks `~/.claude/projects/*/*.jsonl`, hits Claude API with a summary prompt, drops into `session_archives/_drafts/`. Backfilled 13 historical sessions (some had lossy summaries because Sonnet 4.5 refuses long JSONL summarization — meta-recursion defense).

**2026-05-04 · Records-request blast** *(Nathan-authored — see index)*

**2026-05-07 · RVM stack + migration-drift CI + soft-delete**
- Ringless voicemail via Slybroadcast + Fish Audio TTS (PRs #117-#120). Two-step Generate → Drop flow.
- Migration-drift CI check (PR #121) — compares `supabase/migrations/` against actually-applied migrations. Fails PR on drift. Requires repo secret `SUPABASE_PAT`. Caught the pre-existing 101-migration drift.
- Soft-delete on `deals` (migration `20260507*`) — the missing migration that took DCC down for ~30 min when Nathan's soft-delete PR shipped without applying it in prod.
- Two Nathan-authored client-notify triggers moved to `supabase/migrations/_pending_review/` because they fired customer emails with no human approval. **Nathan owes a decision on approval flow before re-attaching.**

**2026-05-08 · Slybroadcast delivery-confirmation contract**
- Every user-driven external side-effect must surface real delivery confirmation, not just "we sent the request." Wired `slybroadcast-callback` EF to update `messages_outbound` with terminal status (delivered / undeliverable / awaiting / failed) + reason. Same pattern applies to Twilio, Resend, DocuSign, eSignatures. Documented in `CLAUDE.md` "Action confirmation" section.

**2026-05-12 · 🚨 SECURITY INCIDENT — Kemper Ansel admin leak** *(Nathan-authored)*
- `handle_new_user`'s fallback was `role='user'` (=admin) instead of `pending`. `client_access` trigger fired before Kemper's auth.users row existed, so email match failed, fallback ran, admin role granted.
- Five-layer hardening: role flipped to client, sessions revoked, `handle_new_user` rewritten with explicit team allowlist + `pending` default, safety trigger on `client_access` INSERT, DCC URL gate, #Ops alert on role promotion. Read the archive before touching auth.

**2026-05-13 · Inbound MMS + iMessage attachments**
- Both Twilio (`receive-sms` EF v51) and mac_bridge inbound paths now download media, upload to new public `inbound-media` bucket at `<deal_id>/<uuid>.<ext>`, store durable URL on `messages_outbound.media_url`.
- UI side already rendered from `media_url` — no `src/app.jsx` change needed.
- Multi-attachment deferred (only first stored in v1). **Justin later reported images "still aren't showing up in DCC or mobile" — refiled as issue #191 for follow-up render bug hunt.**

**2026-05-24 · Twilio default outbound rollout (PR #211)**
- A2P 10DLC campaign on `+15139985440` flipped to VERIFIED (was bouncing FAILED ↔ IN_PROGRESS since 5/12).
- `OutreachDraftPanel` + `SendIntroTextModal` swapped from hardcoded/mac_bridge-only defaults to loading `phone_numbers` and preferring `gateway='twilio'`. Dropdown reorder so Twilio appears first.
- Mac bridge retained as per-message fallback via UI selector.

**2026-05-26 · Backlog grooming — 28 issues filed (#186-#215)**
- Mined ~500MB of prior session transcripts for every "I want to build X" / "we need to fix Y" I'd said across 6 weeks. Cross-referenced against 5 existing open issues. Filed 28 missing ones.
- Bundle: 17 web (badges, dialer, tab persistence, Relay coach, Relay→Comms default, MMS surface, payroll, no-optimistic audit, call popup polish, RVM thread sizing, Slybroadcast callbacks, Ask-Lauren delete, STOP/HELP responder, layout polish, GHL nav strip, eSign decom verify) + 13 mobile (CallKit dialer, push via pg_net, search, case intel, voice Lauren, safe-area, tab bar, 5440 routing, FAB, Forecast, group-chat UI, in-app updates, version display) + 3 cross-platform (group chats #176, MMS #191, Android RCS #215).
- Session-search dual path documented in `memory/session_search_pattern.md` — native MCP tool in interactive sessions; bash grep on `~/.claude/projects/*/*.jsonl` in unsupervised mode (allowlist doesn't bypass the unsupervised gate).
- A2P monitoring retired (`20260526200000_drop_a2p_campaign_monitoring.sql`) — campaign verified, no more polling needed. `check-a2p-campaign-status` EF replaced with 410 Gone stub.

**2026-05-27 · Payroll ledger + reminder cron + Relay coordination**
- Historical payroll archive (tables + import) + live payroll enhancements (hours edit, rate notes, bonuses).
- Payroll reminder migration (`20260527*_payroll_reminders.sql`) + `send-payroll-reminder` EF.
- Nathan's #237 (surplus confidence-tier badge/filter) + coordination on Relay/Automations split. Session archive at `session_archives/2026-05-27-payroll-*`.
- Same day: Sequoia restored on Mac Mini, LaunchAgent for bridge got wedged (`launchctl bootstrap` → I/O error 5). Bridge autostart re-wired via **`~/Applications/DCCBridge.app` Login Item**, NOT launchd. Old `com.refundlocators.bridge` plist moved to `.disabled-superseded-by-loginitem`. DO NOT re-add the LaunchAgent. Bridge deploy over SSH pulls code but restart MUST come from GUI session (Login Item relaunches with new code on login, or double-click DCCBridge.app on the Mini).

**2026-05-28 · Automations paused — clean slate**
- Emptied `relay_enrollments` + `outreach_queue`. Both Relay crons (jobid 21 auto-enroll + 22 dispatcher) set `active=false`. Review Mode still ON.
- **Read `memory/automations_paused_clean_slate.md` before re-enabling** — has resume runbook + the "delete-alone-isn't-enough, pause the cron first" lesson.

### 2026-06 (mobile inbound/outbound calling + iOS build chain)

**2026-06-01 · Mobile release gate scaffolded**
- `mobile/contracts/inbound-callkit.yaml` + `mobile/contracts/asc-verify.mjs` — machine-verifiable pre-build check. Every dependency link (Apple certs, Twilio credentials, Supabase secrets, edge-function deploys, runtime registration) returns GO / NO-GO / NEEDS-HUMAN.
- Skills: `release-check`, `release-readiness` agent, `mobile-prebuild-gate` skill, `eas-build-gate` hook. Every `eas build` / `eas submit` is now blocked until the contract passes.
- Full context: `memory/mobile_release_gate_inbound_callkit.md`.

**2026-06-03 · Capture + link EVERY call**
- Merged to `main` (`bb83c1a`). Every inbound/outbound call now links to a deal/contact through ONE shared `resolve_call_link(p_number)` RPC (migration `20260603120000`) instead of four brittle number-matches.
- `SECURITY DEFINER`, search_path pinned, reviewer-confirmed injection-safe.
- 4 EFs re-wired + deployed: `twilio-voice` v65, `twilio-voice-outbound` v38, `mobile-place-call` v11, `twilio-voice-status` v60 (verify_jwt preserved: 3 webhooks=false, mobile-place-call=true).
- `twilio-voice-status` also got: safety-net orphan-linker backfill + **DND gate** on the missed-call auto-SMS (was firing with no `do_not_text` / deceased / `phone_status` check — pre-existing landmine now closed; inbound-only + fail-safe).
- Web: global `CallHistoryView` now renders recording players (was the one call surface missing them).
- Mobile OTA (runtime 0.1.0, both platforms): deal screen + quick-call typeahead pass `contactId` at dial for contact-level threads.
- Backfill: 14 orphan calls linked to 6 deals (contact-linked-to-1-deal only). Orphans went 61 → 47. Test numbers left as orphans by design.

**2026-06-04 · Outbound calling shipped via EAS Update (OTA)**
- Runtime 0.1.0 OTA on `preview` channel. Twilio Voice SDK v1.7.0 dials in-app; navy in-call screen suppressed for outbound (`isOutboundCallActive()` guard); free DCC navigation mid-call; verified on-device.
- Files: `mobile/lib/voice.ts` (added `_outboundCallActive` + `isOutboundCallActive()` + `contactHandle`), `mobile/lib/dial.ts` (displayName), `mobile/app/quick/call.tsx` + `mobile/app/deal/[id].tsx` (SDK path returns silently, no modal).
- **Three durable OTA/EAS gotchas** (all documented at `session_archives/2026-06-04-outbound-calling-ota.md`):
  1. An OTA only reaches a build if published AFTER that build was built. Four earlier OTAs were dead because Build 26 postdated them.
  2. `EXPO_TOKEN` was wrapped in literal angle brackets → "bearer token invalid." Strip with `EXPO_TOKEN="${EXPO_TOKEN//[<>]/}"`.
  3. Use homebrew `eas` (`/opt/homebrew/bin/eas`), NOT `npx eas-cli@latest`. Different binary, different auth.

**2026-06-05 · Inbound calling finished + build branch reconciled**
- Fixed the Build 26 notification-tap SIGABRT: supabase-js v2 reuses `RealtimeChannel` by topic → fast remount's second `.on('postgres_changes')` after `subscribe()` threw uncaught → RN escalated to fatal SIGABRT killing app + active call.
- Fix: `chanName()` unique-topic helper applied across all 10 realtime channels in `mobile/`.
- Inbound nav pattern: CallKit owns the call UI; DCC navigates to the deal only on Accept, not on ring.
- **Reconciled `justin/eas-preview-distribution-store` into `main`** (8 conflicts; `twilio-voice` kept main's correct fallback number; call sites thread both `contactId` + `displayName`). **Main is now the mobile build source; the build branch is retired.** All future EAS builds come from `main`.
- Verified on-device: 2 calls, deal auto-opened, no crash.

**2026-06-09 · Field-blanking bug fix (issue #326) + realtime diff-merge — this session**
- Phase 1a: migration `20260609200000_deals_phase1a_promote_meta_to_columns.sql` — promoted 28 frequently-edited `deals.meta` keys to real columns (verified/verifiedAt/deceased/deceased_at/obituary/obituary_added_at/attorney→attorney_name/feePct/attorneyFee/zillowLink/sheriffDocketLink/documentLinks/mortgageHistory/involuntaryLiensDetails/openLiens/openLiensCount/mortgageBalance1/lienBalance1/estimatedAvailableEquity/verifiedSurplus/contractPrice/listPrice/wholesalePrice/lienPayoff/flatFee/buyerAgentPct/closingMiscPct/strategy). Backfilled from meta with `nullif(trim(...), '')` casting. Fully additive, zero behavior change.
- Phase 2: migration `20260609210000_deals_phase2_column_sync_trigger.sql` — 5 more columns (state, foreclosure_file_date, confirmation_of_sale_date, redemption_deadline, court_appraisal_order_date — the exact fields Eric named in the field-disappearing repro). BEFORE UPDATE trigger `tg_sync_deals_meta_from_columns()` mirrors any column change back into `meta.<camelKey>` in the same statement so mobile/EFs/intel-main keep reading meta unchanged.
- Phase 2 JS: `useDealMetaBuffer` in `src/app.jsx` now splits its pending patch into column-writes (33 mapped keys) vs. meta-only. Column writes go as top-level UPDATE keys. `META_TO_COLUMN` map + `coerceColumnValue` helpers near the buffer definition.
- Phase 3: realtime diff-merge. Replaced the "any deals event → full 1.3MB reload" with `applyDealChange(payload)` — single-row UPDATE/INSERT/DELETE swap with an `updated_at` out-of-order guard. Dropped the 60s `setInterval(loadDeals)` poll. Kept visibility-change `loadDeals()` for tab-return reconciliation.
- Result: two operators editing different fields on the same deal can no longer clobber each other. ~99% fewer bytes per realtime change. See PRs #326-related commits `c178efd`, `69729b7`, `fde340c`.
- Also this session: chat notification catchup for backgrounded tabs (Chrome throttles WS on hidden tabs — visibility-change handler now pulls missed `team_messages` since `dcc_chat_lastseen_<uid>` in localStorage; fires chirp + toast + count refresh on catchup). Commits `12fd7ce`, `faa0cad`.

### Merged PR log (by number, chronological)

**June 2026 (deal reliability + comms unification):**
- [#326](https://github.com/TheLocatorOfFunds/deal-command-center/pull/326) — Phase 1a/2/3 field-blanking fix: 33 meta keys → columns, per-field writes, realtime diff-merge (this session).
- [#325](https://github.com/TheLocatorOfFunds/deal-command-center/pull/325) — Chat catchup toasts + field-merge defense in SurplusOverview/FlipOverview (background-tab notification repair).
- [#324](https://github.com/TheLocatorOfFunds/deal-command-center/pull/324) — Reply + call-back on UNLINKED global Comms threads; per-deal composer; phone normalization.
- [#323](https://github.com/TheLocatorOfFunds/deal-command-center/pull/323) — Merge emoji reactions with parent SMS thread.
- [#322](https://github.com/TheLocatorOfFunds/deal-command-center/pull/322) — Contacts Phase 3 cleanup (removed stale meta-referencing UI messages).
- [#321](https://github.com/TheLocatorOfFunds/deal-command-center/pull/321) — Contacts Phase 2: homeowner contact becomes source of truth.
- [#320](https://github.com/TheLocatorOfFunds/deal-command-center/pull/320) — Contacts Phase 1: homeowner is a real `contacts` row with backfill + realtime trigger.
- [#319](https://github.com/TheLocatorOfFunds/deal-command-center/pull/319) — Edit pencil on homeowner contacts (Sha Johnson fix).
- [#318](https://github.com/TheLocatorOfFunds/deal-command-center/pull/318) — X actually unlinks the contact + adds pencil to edit.
- [#317](https://github.com/TheLocatorOfFunds/deal-command-center/pull/317) — Mobile: composer scrolls to top of viewport on focus.
- [#316](https://github.com/TheLocatorOfFunds/deal-command-center/pull/316) — Universal from/to + via chip on every call surface.
- [#315](https://github.com/TheLocatorOfFunds/deal-command-center/pull/315) — Show from/to phone numbers on calls.
- [#314](https://github.com/TheLocatorOfFunds/deal-command-center/pull/314) — Route to contact's active deal when stored deal_id is deleted.
- [#313](https://github.com/TheLocatorOfFunds/deal-command-center/pull/313) — Empty-state when comms link points to deleted deal.
- [#312](https://github.com/TheLocatorOfFunds/deal-command-center/pull/312) — Edit-in-place on per-deal vendor cards.
- [#311](https://github.com/TheLocatorOfFunds/deal-command-center/pull/311) — Add deal address to inbound-call push body.
- [#309](https://github.com/TheLocatorOfFunds/deal-command-center/pull/309) — Push notification on inbound call w/ assignee + deal.
- [#308](https://github.com/TheLocatorOfFunds/deal-command-center/pull/308) — Incoming-call modal shows deal assignee.
- [#307](https://github.com/TheLocatorOfFunds/deal-command-center/pull/307) — Per-agent attribution on `call_logs.user_id`.
- [#305](https://github.com/TheLocatorOfFunds/deal-command-center/pull/305) — Assignee dropdowns show team only + capitalize.
- [#304](https://github.com/TheLocatorOfFunds/deal-command-center/pull/304) — Always-visible assignee filter on Leads hub filter bar.

**May–June 2026 (Leads hub redesign + phase-gating):**
- [#302](https://github.com/TheLocatorOfFunds/deal-command-center/pull/302) — Rename hasCollectedAmount → hasActualFee.
- [#301](https://github.com/TheLocatorOfFunds/deal-command-center/pull/301) — Gate Closed on existing `actual_net` field.
- [#300](https://github.com/TheLocatorOfFunds/deal-command-center/pull/300) — Mobile Build 30 batch: keyboard dismiss, IA chip strip, Tap-to-text, label parity.
- [#299](https://github.com/TheLocatorOfFunds/deal-command-center/pull/299) — Rename Deals hub → Leads; drop Flagged + Hygiene chips.
- [#298](https://github.com/TheLocatorOfFunds/deal-command-center/pull/298) — Tighten Closed to require `collectedAmount` (Phase 2 of #292).
- [#297](https://github.com/TheLocatorOfFunds/deal-command-center/pull/297) — `meta.collectedAmount` input + Financial Summary line.
- [#296](https://github.com/TheLocatorOfFunds/deal-command-center/pull/296) — Split Surplus from Closed into Deleted tab (Phase 1 of #292).
- [#293](https://github.com/TheLocatorOfFunds/deal-command-center/pull/293) — Canonical UI-label mapping (`LABELS.md`).
- [#281](https://github.com/TheLocatorOfFunds/deal-command-center/pull/281) — Reconcile build branch into main: inbound + outbound calling. **Retired `justin/eas-preview-distribution-store` as build source.**
- [#253](https://github.com/TheLocatorOfFunds/deal-command-center/pull/253) — Dead-number registry: block re-adding disconnected phones.
- [#211](https://github.com/TheLocatorOfFunds/deal-command-center/pull/211) — Twilio default outbound rollout (+15139985440 preferred over mac_bridge in dropdowns).

**April–May 2026 (RVM + comms + Relay + payroll + integrations):**
- Comms/Voice bootstrap PRs (#101-#210 range): browser calling wiring, ringtone/notification sounds, recording playback, caller ID routing, floating dialpad, device init, Twilio identity nav refactor, video rooms scaffold.
- RVM shipping: PRs #117-#120 (Slybroadcast API, Fish Audio TTS, two-step Generate→Drop flow, security hardening).
- Migration-drift CI: PR #121.
- DocuSign SMS signing flow, Resend webhook, Twilio callback, contact dropdowns, envelope files (May 2026 batch).
- Relay engine (May–June): schema, enrollment triggers, deal review panel, DTMF keypad, blind transfer.
- Payroll & time tracking (May): pay-period tabs, hours edit, rate notes, bonuses.
- Automations & outreach (April–May): Outreach redesign, stuck-row detection, SMS splitting, 6s polling fallback.
- Mac bridge (April, deep session): Mac Mini bridge, service UUIDs, delivery checks, AppleScript send, auto-restart probes, business comms pipeline, morning-sweep, monday-memo.

### Active/recent Justin branches (as of ~2026-06-09)
- `origin/justin/notif-catchup-and-field-merge` (this session's work, likely #325 base)
- `origin/justin/mobile-build31-comms-inline`
- `origin/justin/mobile-xcode26-patch-package`
- `origin/justin/contract-human-confirmed-build29`
- `origin/justin/call-capture-linking`
- `origin/justin/hide-automations-noise`
- `origin/justin/payroll-period-tabs`
- `origin/justin/drain-automations-queue`
- `origin/justin/automations-phase2-reshape`

Nathan: assume any of these that haven't been merged represent in-flight or abandoned work. Ping me before deleting.

---

## 3. Mobile app — current state

- **App name:** DCC (bundle `com.fundlocators.dcc`, Apple team `8RJDH7L35Q`, App Store Connect app `6768752406`).
- **Distribution:** TestFlight internal (Nathan + Justin + Eric).
- **Build source:** `main` branch as of 2026-06-05 (the `justin/eas-preview-distribution-store` branch is retired).
- **Runtime version policy:** `appVersion` — currently `0.1.0`. OTA updates via `preview` channel.
- **Build number:** managed by EAS; `mobile/app.json` `buildNumber` field is not the source of truth. Check `eas build:list --platform ios --limit 1` for the actual latest.

**Native modules installed** (from `mobile/package.json`):
- `@twilio/voice-react-native-sdk` ^1.4.0 (upgraded to 1.7.0 for outbound calling in Build 26+; check current pin)
- `expo-notifications`, `expo-router`, `expo-updates`, `expo-dev-client`, `expo-linking`, `expo-application`, `expo-device`, `expo-font`, `expo-splash-screen`, `expo-asset`
- Custom config plugin at `mobile/plugins/with-twilio-voice.js` — wires the native Twilio Voice SDK into Expo's managed workflow
- `@supabase/supabase-js` ^2.45.0

**Release gate (mandatory before ANY `eas build` / `eas submit`):**
- Skill `release-check inbound-callkit` walks the config chain (Apple certs, Twilio push cred, Supabase EF deploys + secrets, runtime SDK registration) and returns GO/NO-GO/NEEDS-HUMAN.
- Enforced by hook `~/.claude/hooks/eas-build-gate.sh` — blocks `eas build`/`eas submit` in every session until a fresh OK marker exists.
- Post-build: `release-check inbound-callkit --post` confirms `voice_sdk_status.status = 'registered'` before declaring the build ready.

**Inbound-CallKit status (as of last check):** was NO-GO through Builds 14-22 because `voice_sdk_status` never reached `registered`. Root cause turned out to be a deleted `voice.initializePushRegistry()` call (a wrong-belief revert baked into `PRE_BUILD_QA.md`). Restored at Build 25 — inbound registered on first try. See `memory/mobile_release_gate_inbound_callkit.md` for the full retrospective.

**Two-store gotcha:** Edge Function secrets (`supabase secrets list`) are NOT the same store as Vault secrets (SQL against `vault.decrypted_secrets`). Both matter; always check both.

**Pre-build QA checklist:** `mobile/PRE_BUILD_QA.md` + skill `mobile-prebuild-gate`. Runs branch/diff sanity, typecheck, expo-doctor, entitlement guard, Twilio SDK method+shape audit against installed `.d.ts`, lifecycle race audit. Skip at your peril — each broken build costs money AND several hours of Apple processing.

**Latest TestFlight state (as of 2026-06-09):** Build 33 shipped with the composer scroll-to-top fix (#317). Inbound CallKit registration was the Build 14-24 saga; Build 25 finally fixed it by re-adding `voice.initializePushRegistry()`. Always verify `voice_sdk_status = 'registered'` for the running build before declaring inbound live.

**ASC API key:** `AuthKey_R79VDA2SMJ.p8`, issuer `d6deea26-4f16-4e54-89e7-c52415af4921`, key id `R79VDA2SMJ`.

**Entitlement rule:** `aps-environment: production` only. `unrestricted-voip` explicitly forbidden (Builds 18-20 burned on this).

**mac_bridge — where it lives and how to deploy**

- Runtime path on the Mini: `/Users/dealcommandcenter/Documents/deal-command-center/mac-bridge/`.
- **Trap:** stale clone at `/Users/dealcommandcenter/Documents/DealCommand Center/deal-command-center/` — deploys there silently no-op. Always confirm the runtime path.
- Files: `bridge.js` (main entry), `package.json` (better-sqlite3 + @supabase/supabase-js + dotenv), `com.refundlocators.bridge.plist` (superseded — do NOT re-enable).
- Autostart: `~/Applications/DCCBridge.app` Login Item on `dealcommandcenter`. GUI session required because AppleScript must drive Messages.app.
- Deploy: `ssh defender-mini` for `git pull`; restart MUST happen from GUI (`open ~/Applications/DCCBridge.app` on the Mini) — SSH restart cannot drive Messages.app.
- Log: `/tmp/dcc-bridge.log`.
- Function: iMessage-only outbound; polls Supabase for `status='pending_mac'` rows; chat.db polls inbound every 5s. Hardcodes `service type = iMessage`, so Android numbers must fall back to Twilio via `phone_numbers.gateway`.

---

## 4. Supabase artifacts I own

**Project:** `rcfaashkfpurkvtmsmeb` (URL `https://rcfaashkfpurkvtmsmeb.supabase.co`).

### Edge functions I own (live unless noted)

**Comms — SMS / iMessage / Email**
- `send-sms` — outbound SMS router; reads `phone_numbers.gateway`, routes to `mac_bridge` (default) or Twilio fallback. Text-splitting is a known regression zone (both branches; see [`memory/mobile_pre_build_qa.md`](~/.claude/projects/-Users-justinjohnson-Documents-deal-command-center/memory/mobile_pre_build_qa.md) and CLAUDE.local.md rule #3).
- `receive-sms` — Twilio inbound SMS webhook; writes `messages_outbound` with `direction='inbound'`; resolves `thread_key` + `deal_id`.
- `twilio-sms-status` — Twilio SMS delivery status callback.
- `send-email` — outbound email via Resend.
- `resend-webhook` — Resend delivery/bounce events.

**Voice — Twilio + mobile Voice SDK**
- `twilio-voice` — inbound TwiML entrypoint (main voice webhook).
- `twilio-voice-outbound` — outbound TwiML for browser/mobile dialer.
- `twilio-voice-status` — call status callback (also fires the DND-gated missed-call auto-SMS).
- `twilio-voice-screen` — call screening (Nathan's 2306 fork).
- `twilio-token` — mints Voice SDK access tokens for mobile + browser (identity `dcc-fundlocators`).
- `twilio-recording` — recording completion callback.
- `twilio-transcription-callback` — transcription completion.
- `twilio-add-to-call`, `twilio-conference-twiml` — conference / multi-party.
- `twilio-diag`, `twilio-diag-5440`, `twilio-debug` — diagnostics (candidates for cleanup — check before deleting).
- `summarize-call` — Claude summary of call transcript.
- `mobile-place-call` — mobile dialer bridge (`verify_jwt=true`).

**RVM (ringless voicemail)**
- `drop-rvm` — Slybroadcast send.
- `slybroadcast-callback`, `slybroadcast-poll` — delivery confirmation loop.

**Mobile push**
- `send-push-notification` — Expo Push dispatcher, fired from `push_notify_*` triggers.

**Outreach / automations**
- `generate-outreach` — Claude-drafted SMS for `outreach_queue`.
- `dispatch-cadence-message` — outreach queue dispatcher.
- `relay-enroll`, `relay-auto-enroll`, `relay-dispatcher` — Relay sequences (currently paused per `memory/automations_paused_clean_slate.md`).

**e-signatures**
- `send-esignature-contract` + `esignatures-webhook` — eSignatures.com pay-as-you-go pipeline.
- `docusign-send-envelope`, `docusign-webhook`, `docusign-sign`, `docusign-status`, `check-docusign-golive` — DocuSign parallel pipeline (Starter tier, awaiting Ricky Olson's prod Go-Live).

**Deprecated / stale**
- `quo-webhook` — old OpenPhone integration, unused. Safe to delete after Nathan double-checks nothing external calls it.

### Migrations I authored (2026-04 → 2026-06-09)

**April (comms bootstrap):**
- `20260420_messages_outbound` + `phone_numbers` — core SMS tables.
- `20260421_messages_direction`.
- `20260422_nathan_imessage_number`, `messages_subject_and_audience`, `messages_auto_route_deal`.
- `20260423_multi_contact_sms_schema`, `guard_trigger_for_imessage`, `cleanup_leaked_group_chat_messages`, `call_recordings`, `call_logs_and_voice`, `emails_log`.
- `20260424_outreach_queue`.
- `20260425_personalized_links_claim_columns`, `outreach_pipeline_sync`, `outreach_queue_cancelled_status`.
- `20260427_messages_outbound_media_url`, `messages_outbound_admin_update`.
- `20260428_personalized_links_admin_policy`, `sync_personalized_link_from_deal`, `personalized_links_per_contact`, `sync_trigger_contact_aware`.

**May (push + Relay + comms hardening):**
- Push: `20260511_profiles_expo_push_token`, `push_notify_inbound_sms`, `push_notify_team_message`, `push_notify_inbound_call`, `profiles_notification_prefs`, `search_deals_full`.
- Relay: `20260512_create_relay_schema`, `relay_seed_sequences`, `expose_relay_schema`.
- e-sig: `20260514_esignatures_contracts`, `agent_feedback_coach_kind`.
- Mid-May: `20260519_team_message_mention_pushes`, `lock_personalized_links_anon_read`, `homeowner_token_sweep`, `dedupe_notification_pushes`.
- Late May: `20260523_push_notify_voicemail_landed`, `call_logs_voice_intake`, `push_notify_agent_intake`.
- Retired A2P monitoring: `20260526_drop_a2p_campaign_monitoring`, `call_disposition_feedback`.
- Payroll + read receipts: `20260527_call_logs_transcript_summary`, `messages_outbound_read_receipts`, `payroll_reminder*`, `outreach_queue_relay_dedup_split`, `outreach_settings_review_mode`.

**June:**
- `20260601_surplus_docket_pulling_ids`.
- `20260603_resolve_call_link` — the shared call→deal/contact resolver RPC (PR #266 backfill).
- `20260604_autoqueue_day0_outreach_on_prep`.
- `20260605_deals_readied_by_attribution`, `unswap_inbound_sms_columns` — receive-sms from/to swap fix.
- `20260608_call_logs_user_id` (per-agent attribution).
- `20260609_push_notify_inbound_call*` (with address + assignee in body).
- `20260609_homeowner_as_contact`, `sync_meta_from_homeowner_contact` — homeowner-as-contact architecture (shared work; see [`memory/homeowner_as_contact_architecture.md`](~/.claude/projects/-Users-justinjohnson-Documents-deal-command-center/memory/homeowner_as_contact_architecture.md)).
- `20260609200000_deals_phase1a_promote_meta_to_columns` + `20260609210000_deals_phase2_column_sync_trigger` — the field-blanking fix (#326).

**IP allowlist gotcha:** the Management API has IP allowlisting enabled. A valid PAT still returns `403 Host not in allowlist` from sandbox/Linux sessions. **Edge function deploys must run from Justin's Mac or the Defender Mini.** Read-only calls (listing functions, `execute_sql`, reading vault secrets via SQL) are NOT affected.

**PAT location** (do not regenerate — the existing one works):
- Justin's Mac: `jq -r '.mcpServers["supabase-dcc"].env.SUPABASE_ACCESS_TOKEN' ~/Library/Application\ Support/Claude/claude_desktop_config.json`
- GitHub Actions: repo secret `SUPABASE_PAT`.

---

## 5. Comms stack (my primary domain)

| Channel | Primary path | Fallback | Confirmed by |
|---|---|---|---|
| **SMS to iPhone (iMessage)** | Mac bridge on defender-mini (Nathan's phone via AppleScript) | Twilio A2P (+15139985440) if bridge down | `messages_outbound.gateway`, `slybroadcast-callback`-style delivery status |
| **SMS to Android** | Twilio A2P (+15139985440), A2P 10DLC verified 2026-05-24 | None (bridge is iMessage-only per AppleScript hardcode) | `twilio-status` callback → `messages_outbound.status` |
| **RVM (ringless voicemail)** | Slybroadcast API | None | `slybroadcast-callback` EF → terminal status + reason |
| **Voice (outbound)** | Twilio Voice SDK (browser or mobile) → `twilio-voice-outbound` EF | None | `call_logs`, `resolve_call_link(p_number)` RPC |
| **Voice (inbound)** | Twilio Voice → `twilio-voice` EF rings `dcc-fundlocators` SDK identity (parallel forks to browser + all mobile devices) + Nathan's `+15135162306` (screened by `twilio-voice-screen`) | None | `call_logs` |
| **Missed-call auto-SMS** | `twilio-voice-status` EF, DND-gated (do_not_text / deceased / phone_status checked) | None | `messages_outbound.direction='outbound'` linked to call_log |
| **e-signature (homeowner-facing)** | eSignatures.com REST via `send-esignature-contract` EF, delivery via iPhone bridge | DocuSign (Ricky Olson prod Go-Live pending; see `memory/docusign_integration_status.md`) | `esignatures_contracts` + `esignatures-webhook` EF |
| **Push notifications (mobile)** | Twilio Voice push cred `CR7fd8d05...` + Apple VoIP cert (production) → CallKit; expo-notifications for chat | None | `voice_sdk_status` table + `push_tokens` (mobile) |

**Hardcoded rule (`CLAUDE.md`):** all outbound SMS/MMS/video routes through Nathan's iPhone via `mac_bridge`. Twilio outbound is the architectural default post-2026-05-24 for Android and iPhone contacts alike, but the fallback in `send-sms/index.ts` remains for `gateway='mac_bridge'` rows in `phone_numbers`. **NEVER extend Twilio outbound in new features; use mac_bridge or the existing send-sms path.**

**A2P monitoring RETIRED** (2026-05-26): campaign verified, dropped `a2p_campaign_status_log` + `verify_a2p_status_secret` RPC + `a2p_status_check_secret` Vault + gutted `check-a2p-campaign-status` EF to 410. Don't re-add.

---

## 6. Open work (what I haven't finished)

<!-- Fill from gh issue list --author @me + open PRs -->

### Open GitHub issues, high-signal
- `#191` — MMS/attachment images "still aren't showing up in DCC or mobile" — refiled for verification pass; ingestion path shipped 2026-05-13 but render bug likely still open.
- `#215` — Android RCS routing.
- `#176` — Group chats.
- `#281` — main-reconcile work is done (2026-06-05), but there may be leftover post-reconcile cleanups; check state.
- **Issue #326 remaining phases:**
  - Phase 1b (Task #29): intel-main-controlled meta keys → columns. Requires intel-main coordination (see DIRECTOR_DCC_INTERFACE.md managed-keys list).
  - Phase 4 (Task #22): full retirement of `deal.meta.homeowner*` keys. See `memory/homeowner_as_contact_architecture.md`.
- **Automations paused** (Task from 2026-05-28): new enrollment rules requested before re-enabling. `automations_paused_clean_slate.md` has the resume runbook.

### Justin's active worktrees (as of 2026-06-09)
- `vigorous-williamson-f7809f` — this session (field-blanking + notifications)
- `quirky-lamarr-8ec4ff`
- `fervent-napier-9c4b2a`

Cross-check `WORKING_ON.md` for the latest.

---

## 7. Rules that will bite you

**As of 2026-07-01** the ten hardest rules were promoted from my personal `CLAUDE.local.md` into team-shared `CLAUDE.md` (see the section **"Team-shared hard rules — the ones we've learned the hard way"**). Nathan's Claude will pick them up on next session-start via the CLAUDE.md load. This section reproduces them for the handoff plus the additional guidance that stayed personal or is already covered elsewhere in CLAUDE.md.

**Now in `CLAUDE.md` (team-shared, both sessions inherit):**

1. **Never declare "done" without verification evidence.** Claude-in-Chrome QA screenshot OR Supabase MCP data-shape check OR explicit "unverified, blocking on X" caveat. Skill `verify-feature` formalizes this.
2. **Never call/text/email a real client from a test path.** Allowlist: `+14797196859` (Justin), Nathan's known number, `justin@fundlocators.com`. iOS sim counts (prod DCC.app + prod Supabase + real Twilio). Safe test contacts in `memory/test_contacts_for_sim_qa.md`.
3. **Check existing infrastructure before creating anything.** ~85 tables + 60+ EFs. `list_edge_functions` / `list_tables` / grep migrations / `gh issue list --search` first.
4. **Estimates in vibe-coding hours, not human-dev hours.** 15-30 min for things a human quotes at "a week."
5. **Don't re-pitch after a decision.** Pick one, execute, move forward.
6. **Team-member first names ≠ homeowner-lead first names.** Scrub Justin/Nathan/Eric/Anam from homeowner-facing copy. Real bug had "Justin" as cosigner in a draft.
7. **File issues in batches ≤6, or sequentially with 30s pauses.**
8. **No em dashes** in any written content.
9. **Do it yourself.** SSH to defender-mini autonomously. Query Supabase MCP. Run `gh`.
10. **Voice the trade-offs once, then act.** Don't list 8 options.

**Already covered elsewhere in `CLAUDE.md`:**

- **Brand boundary FundLocators vs RefundLocators** — see the "Email templates brand rule" and "Inbound email reality" sections.
- **Always `git pull` before WORKING_ON.md state assertions** — implicit in the session-start ritual.
- **Never build/ship mobile without `/release-check` first** — enforced by the `eas-build-gate.sh` hook and documented in "Mobile build & branch flow".
- **mac_bridge for outbound SMS, NEVER Twilio for new features** — see the ⚠️ "Messaging gateway" section.
- **intel-main writes specific `deals.meta` keys** — see [`DIRECTOR_DCC_INTERFACE.md`](DIRECTOR_DCC_INTERFACE.md) managed-keys list.

**Additional soft preferences from `memory/preference_*` (stayed personal):**
- Pay-as-you-go vendors preferred over monthly subscriptions (rejected VoiceDrop.ai for $495/mo minimum).
- Universal UI changes: when I ask for a UI change, apply it to EVERY surface the concept renders — not just the screen I was looking at.
- Background long-running checks (`run_in_background: true`) — never sleep-poll.

---

## 8. Where to look next (pointers into the repo)

- **Architecture / conventions:** [`CLAUDE.md`](CLAUDE.md) at repo root — schema table, RLS model, deployment flow, top-level views, common change recipes, gotchas.
- **Cross-project contract:** [`DIRECTOR_DCC_INTERFACE.md`](DIRECTOR_DCC_INTERFACE.md) — every managed `deals.meta` key + trigger + push behavior.
- **Live cross-session state:** [`WORKING_ON.md`](WORKING_ON.md) — "Justin's session" section; per-worktree subsections underneath.
- **Session archives (durable per-session learnings):** [`session_archives/`](session_archives/) — 12 of mine, indexed at [`session_archives/index.md`](session_archives/index.md).
- **My personal memory (26 files):** `~/.claude/projects/-Users-justinjohnson-Documents-deal-command-center/memory/` — index at `MEMORY.md`. Nathan won't see these in his own session; the ones marked "worth promoting" (mobile release gate, automations paused, homeowner-as-contact, universal UI, no em dashes, pay-as-you-go) can go into team-shared `CLAUDE.md` if Nathan wants.
- **Mobile pre-build QA:** [`mobile/PRE_BUILD_QA.md`](mobile/PRE_BUILD_QA.md) + skill `mobile-prebuild-gate`.
- **Mobile release contracts:** `mobile/contracts/inbound-callkit.yaml` + `mobile/contracts/asc-verify.mjs`.
- **Comms plan:** `COMMS_PLAN.md` — Twilio setup checklist, 10DLC framing, EF URLs, opt-in language.
- **Mac bridge recovery:** `docs/MAC_BRIDGE_RECOVERY.md` — VNC/SSH recovery after power outage.
- **A2P registration package:** `docs/A2P_10DLC_REGISTRATION.md` — full submission + audit + TCPA.
- **DocuSign go-live runbook:** `docs/DOCUSIGN_GOLIVE_CUTOVER.md` — waiting on Ricky Olson's Production approval (per `memory/docusign_integration_status.md`).

---

## 9. Handoff checklist for Nathan

When you pick this up:

1. `git pull` in the repo root and read `WORKING_ON.md` — my last worktree may have a fresh update.
2. Skim `session_archives/index.md` for the 12 Justin-authored entries (they're marked with the Justin badge). Read the archive if you need detail; skim if the index line already tells you what you need.
3. If you're touching anything in my domain column (§1 above), post a note in `WORKING_ON.md`'s Nathan section before starting.
4. For mobile: NEVER run `eas build` without the release-check first. It's enforced by hook.
5. For Supabase: read-only calls work from anywhere; deploys require Justin's Mac or Defender Mini.
6. For SMS: mac_bridge is primary. Don't add Twilio-native features.
7. Automations are paused. Don't re-enable without reading `memory/automations_paused_clean_slate.md`.
8. e-signatures: DocuSign is waiting on Production Go-Live (Ricky Olson, ≤48hr ETA when last checked). eSignatures.com pilot is live and pay-as-you-go.

---

*End of handoff. Stale entries welcome corrections — this doc will drift the moment I merge my next PR.*
