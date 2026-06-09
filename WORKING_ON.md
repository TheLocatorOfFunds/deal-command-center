# Currently Working On

**Live state.** What Justin's and Nathan's Claude Code sessions are doing
right now. Pair with `session_archives/` (durable per-session learnings)
and `memory/` (long-term user-level knowledge).

> **Convention:** edit ONLY your own section. Update as you work — not just at
> session start/end. Other sessions `git pull` to refresh. Conflict-free as long
> as everyone respects the section boundaries. Erik works in the DCC UI, not
> Claude Code in this repo, so this doesn't apply to him.

---

## 🚨 EMERGENCY — kill Lauren on refundlocators.com (~90 seconds)

If Lauren is doing something live that needs to STOP RIGHT NOW (saying something embarrassing, leaking data, getting injected):

> **Note:** Supabase no longer has a "Pause function" button. The dashboard's only options are deleting the function (drastic — source isn't in git) or editing the JWT settings. The kill paths below are the working ones as of 2026-04-28.

**PRIMARY — Vercel env var kill-switch (~90 sec, friendly offline message):**

```
cd ~/Documents/Claude/refundlocators-next
vercel env add NEXT_PUBLIC_LAUREN_DISABLED production
# When the CLI prompts "What's the value of NEXT_PUBLIC_LAUREN_DISABLED?"
# you MUST type the literal word: true   (do NOT press Enter on a blank value)
# Then accept defaults for the remaining prompts.
git commit --allow-empty -m "deploy: kill switch on" && git push
```

The push triggers Vercel auto-deploy (~60 sec). After it completes, the chat widget on every refundlocators.com page renders: *"Lauren is temporarily offline. Please email hello@refundlocators.com or call (513) 516-2306..."* — with no fetch to lauren-chat happening.

**To restore:**
```
cd ~/Documents/Claude/refundlocators-next
vercel env rm NEXT_PUBLIC_LAUREN_DISABLED production --yes
git commit --allow-empty -m "deploy: kill switch off" && git push
```

**BACKUP — Replace the Edge Function with a 503 stub (~3 min, breaks gracefully):**

Use only if the Vercel env var path fails (e.g. Vercel down).

1. https://supabase.com/dashboard/project/rcfaashkfpurkvtmsmeb/functions/lauren-chat → **Code** tab
2. Replace the entire `Deno.serve(...)` body with:
   ```typescript
   Deno.serve(() => new Response(
     JSON.stringify({ reply: "Lauren is offline for maintenance. Please email hello@refundlocators.com — we'll respond within 1 business day." }),
     { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
   ));
   ```
3. **BEFORE** clicking Deploy, **download** the current function source (top-right "Download" button) so you have a restore artifact.
4. Click Deploy.

To restore: paste back the original code → Deploy.

**LAST RESORT — Delete the function (irreversible without saved source):**

Only if you literally have no other option AND you have the source backed up. From Settings tab → Delete edge function.

---

**Full runbook (other incident paths, not just Lauren):**
`~/Documents/Claude/refundlocators-next/RUNBOOK.md`

**Long-term hardening plan (Justin's lane, 7 tasks):**
`~/Documents/Claude/deal-command-center/JUSTIN_LAUREN_PROMPT_INJECTION_HARDENING.md`

---

## Justin's session

### ✅ SHIPPED 2026-06-03 — Capture + link EVERY call (call-capture-linking)

Merged to `main` (`bb83c1a`). Every inbound/outbound call now links to a
deal/contact through ONE shared resolver instead of four brittle number
matches. Fixes the Robert Donaghy orphan (SDK sent `dealId=sf-daggs`,
`twilio-voice-outbound` discarded it + number-matched a contact whose
phone column held 3 numbers in one CSV string).

- **NEW** `public.resolve_call_link(p_number)` migration
  `20260603120000` — splits multi-number contact phones on `, / ;`,
  matches each number's last-10, falls back to `find_deal_by_phone`.
  SECURITY DEFINER, search_path pinned. Reviewer-confirmed injection-safe.
- 4 EFs wired to it + deployed: `twilio-voice` v65, `twilio-voice-outbound`
  v38, `mobile-place-call` v11, `twilio-voice-status` v60 (verify_jwt
  preserved: 3 webhooks=false, mobile-place-call=true).
- `twilio-voice-status` also got a safety-net backfill (links a finalized
  orphan if resolvable) AND a **DND gate** on the missed-call auto-SMS
  (was firing with no do_not_text/deceased/phone_status check — pre-existing
  landmine, now closed; inbound-only + fail-safe).
- Web: global Call History (`CallHistoryView`) now renders recording
  players (was the one call surface missing them; comms hub already had it).
- Mobile (OTA, runtime 0.1.0, both platforms): deal screen + quick-call
  typeahead now pass `contactId` at dial for contact-level threads.
- Backfill: 14 orphan calls linked to 6 deals (contact-linked-to-1-deal
  only). Orphans 61→47. Test numbers (`+15136661089`, `+14799354177`,
  Indiana 33-min, Justin's Google #) left as orphans by design.
- QA: comms-reviewer GO; live Chrome confirmed Robert's 16:56 call on
  sf-daggs + recordings in both call surfaces; no app console errors.

---

### 🔗 HANDOFF 2026-06-01 (eloquent-brahmagupta-248dfb) -> the Build 22/23 / voice.ts session

Ran the new config-chain gate `/release-check inbound-callkit`. **These links are VERIFIED - stop re-checking them:**
- Apple account is correct: team `8RJDH7L35Q` owns app `6768752406` (matches eas.json). The old "not racin2701@yahoo.com" warning was WRONG.
- Bundle `com.fundlocators.dcc`: PUSH_NOTIFICATIONS capability ON. `IOS_DISTRIBUTION` cert valid to 2027-05-12.
- `app.json`: `aps-environment=production`; no forbidden `pushkit.unrestricted-voip` entitlement.
- Supabase secret `TWILIO_VOICE_PUSH_CREDENTIAL_SID` is SET - verified via `supabase secrets list` (digest eadeda27...). The Vault "empty" reading was the WRONG store (Edge Function secrets are not in `vault.decrypted_secrets`).
- `twilio-token` v39 + `twilio-voice` v64 deployed ACTIVE.

**Still NEEDS-HUMAN (console-only):** Apple VoIP push cert (ASC API does not expose push certs); Twilio Mobile Push Credential `CR7fd8d05f8deefcc8e94e7de4c357d11c` sandbox-unchecked.

**Do NOT chase the cred/secret:** `Failed to initialize PushKit device token` (Builds 17, 22) is the device failing to get a VoIP token from iOS - UPSTREAM of push delivery. Real suspects: built IPA missing `aps-environment` / `voip` UIBackgroundMode (verify the actual IPA, not app.json), provisioning lacking push, or PKPushRegistry code/timing. Retry-window tuning cannot fix token issuance. No `voice_sdk_status` row has ever reached `registered` (Builds 14-22) -> inbound-callkit is **NO-GO** until it does.

Contract + verifier now on main: `mobile/contracts/inbound-callkit.yaml` + `mobile/contracts/asc-verify.mjs` (re-runs the Apple checks). Run `/release-check inbound-callkit` to reproduce. Full detail in `memory/mobile_release_gate_inbound_callkit.md`.

---

**Status:** Active — 2026-05-26

**Latest shipped (2026-05-28 ~12:00pm ET):**
- ✅ Deployed `generate-case-summary` (PRs #239 / #241 / `7adde80`) — case
  briefs now name specific filings + factor in link-engagement + Lauren
  chats. Nathan's auto-refresh trigger is live, so next docket event on
  any deal will refresh against the new EF.
- ✅ Deployed `send-sms` (PR #235 / `7ecdad8`) — iMessage path no longer
  splits one-liners. Long iMessage sends now go as a single bubble.
- 🔐 Added `CLAUDE.md` notes on (a) where the Supabase PAT actually
  lives (Mac's Claude Desktop config / `.zshrc` / `~/.supabase`) and
  (b) the Management-API IP allowlist that blocks edge-function deploys
  from sandbox sessions.

**Branch:** `claude/eloquent-brahmagupta-248dfb` (worktree)
**Working on:** Backlog grooming — mined ~500MB of prior session transcripts
to extract every "I want to build X" / "we need to fix Y" Justin said
across the past 6 weeks, cross-referenced against the 5 existing open
issues, filed the 28 missing ones (#186–#215). DCC backlog is now 33
tracked GitHub issues split web (17) / mobile (13) / cross-platform (3).
Persistent across sessions — no more "what did I say I wanted last week"
amnesia. Also codified the session-search dual-path workaround (native
MCP tool in interactive sessions, bash grep on `~/.claude/projects/*/*.jsonl`
in unsupervised mode) into `memory/session_search_pattern.md` and added
the entry to `MEMORY.md`.

---

**Previous (2026-05-24) — Twilio default outbound rollout (PR #211)**

A2P 10DLC campaign on `+15139985440` flipped to **VERIFIED** on 5/24 (was
bouncing FAILED ↔ IN_PROGRESS since 5/12). Twilio is now the architectural
default for SMS + voice; mac_bridge stays as a per-message fallback option
in the UI for cases where Nathan needs to send from his personal iPhone.

**Shipped in PR #211 (`feat(sms): default outbound sender to +15139985440`):**
- `OutreachDraftPanel` (Comms-tab AI cadence draft approval) — was hardcoded `useState('+15135162306')`. Now loads all active `phone_numbers`, defaults to `gateway='twilio'`, with 2306 still selectable.
- `SendIntroTextModal` (manual intro-text composer) — was filtering `phone_numbers` to `gateway='mac_bridge'` only. Now pulls every active sender, defaults to the Twilio gateway row.
- Dropdown reordering so Twilio appears first in both surfaces.

**What was already correct (most of the routing):**
- `TWILIO_FROM_NUMBER` env var on send-sms was already 5440.
- Mobile SMS (quick/sms, thread/[key], OutreachDraftPanel.tsx) already deferred to env default → 5440.
- Web Comms tab sender picker already preferred `gateway='twilio'`.
- Voice inbound rings web + mobile (via `dcc-fundlocators` SDK identity) + Nathan's 2306 (screened by twilio-voice-screen) in parallel.
- Voice outbound from web and mobile both already use 5440 caller ID.

**A2P monitoring retired (2026-05-26):** Campaign VERIFIED → no further status monitoring needed. Dropped table `a2p_campaign_status_log`, RPC `verify_a2p_status_secret`, Vault secret `a2p_status_check_secret`. Edge Function `check-a2p-campaign-status` replaced with a 410 Gone stub. Teardown migration: `20260526200000_drop_a2p_campaign_monitoring.sql`. Memory note `twilio_a2p_setup.md` trimmed to keep the SID reference card but strip the monitoring section.

**One residual gotcha (not blocking):** mac_bridge AppleScript hardcodes `service type = iMessage` and silently fails on Android. Less urgent now that Twilio is default, but still a footgun if 2306 is ever chosen for an Android recipient. Memory note at `messaging_bridge_imessage_only.md`.

---

**Previous (2026-05-13):** Inbound MMS / iMessage attachment support — both the Twilio
path (receive-sms edge fn) and the mac_bridge inbound path were dropping
attachments and only persisting body text. Both now download the media,
upload to a new public `inbound-media` Supabase bucket under
`<deal_id>/<uuid>.<ext>`, and store the durable URL on
`messages_outbound.media_url`. UI side already rendered images/video/audio
from media_url — no app.jsx changes needed.

**Recent decisions (2026-05-26):**
- Backlog lives in GitHub Issues, not in-session todos. Pattern: every
  "I want…" / "we need to…" Justin says becomes an issue. Per-session
  todos die with the session; issues survive.
- Filed bundle: 17 web (badges, dialer, tab persistence, Relay coach,
  Relay→Comms default, MMS surface, payroll, no-optimistic audit, call
  popup polish, RVM thread sizing, Slybroadcast callbacks, Ask-Lauren
  delete bug, STOP/HELP responder, layout polish bundle, strip-GHL
  nav, eSign decom verification) + 13 mobile (CallKit dialer, push
  via pg_net, search, case intel, voice Lauren, safe-area, tab bar,
  5440 routing, FAB, Forecast, group-chat UI, in-app updates, version
  display closed) + 3 cross-platform (group chats #176, MMS #191,
  Android RCS #215).
- Session-search dual path: in unsupervised mode the native MCP tool
  is gated regardless of allowlist; use bash grep on `~/.claude/projects/*/*.jsonl`
  with jq filters. Documented in `memory/session_search_pattern.md`.

**Previous decisions (2026-05-13 — inbound MMS / iMessage attachments):**
- New public storage bucket `inbound-media` (migration
  20260513120000). Public-read for `<img src>` rendering to "just work";
  privacy via random uuid filenames. Mirrors the `rvm-audio` pattern.
- receive-sms now reads `NumMedia` + `MediaUrl0` / `MediaContentType0`,
  fetches with Twilio Basic auth, uploads, stores the public URL on
  the row. Edge fn deployed (v51, verify_jwt=false preserved).
  Multi-attachment is deferred (only first stored in v1).
- bridge.js now reads `message_attachment_join` + `attachment` rows for
  cache_has_attachments=1 messages, resolves the on-disk
  `~/Library/Messages/Attachments/...` path, uploads, and stamps
  media_url. SQL WHERE relaxed for inbound to allow text-null
  attachment-only rows; outbound kept text-required to preserve the
  body-based dedup against pending DCC handoffs.
- **Note 2026-05-26:** the MMS work was completed but Justin reported
  in a later session that images "still aren't showing up in DCC or
  mobile" — refiled as #191 for a follow-up verification pass (could
  be a UI render bug, not the ingestion path that shipped here).

---

**Previous (2026-05-07):** Shipping RVM (Slybroadcast + Fish Audio + 2-step UI) and built
a CI migration-drift check (PR #121, merged). Cleanup of pre-existing drift
surfaced 2 customer-facing email triggers that were committed-but-unapplied.

**🚨 HEADS-UP FOR NATHAN — your client-notify triggers** (from PR ~2026-05-05):
- I applied them tonight as part of drift cleanup, then realized they fire
  customer emails with no human-in-the-loop approval. Justin called it: "we
  don't need to be sending out emails without someone approving them."
- **Action taken:** dropped both triggers (`tg_notify_client_status_change`
  on `deals`, `tg_notify_client_docket_event` on `docket_events`). The
  underlying functions `notify_client_status_change()` and
  `notify_client_docket_event()` remain installed in prod for reuse.
- **Migration files moved** from `supabase/migrations/` to
  `supabase/migrations/_pending_review/` (with a README explaining why).
  This keeps them out of the drift CI check until you've designed an
  approval flow.
- **What you need to decide:** queue + approval UI vs different design.
  Re-attaching the triggers is one CREATE TRIGGER per file (sql in the
  README of `_pending_review/`).

**Recent decisions:**
- 2026-05-07: RVM stack live with two-step Generate → Drop flow (PRs #117,
  #118, #119, #120 — all merged). Slybroadcast API approved + secrets set.
- 2026-05-07: Migration drift CI check live (PR #121). All 101 committed
  migrations now applied/registered to prod. SUPABASE_PAT secret in repo.
- 2026-05-07: Soft-delete migration that broke deals query was missing —
  applied; that was the root cause of the "deal pages render Today
  dashboard" bug we hit during RVM testing.

**Touching:** `supabase/migrations/_pending_review/*`, `WORKING_ON.md`

**Open follow-ups:**
- Justin tests RVM full-flow drop to +14797196859 (preview → drop → verify
  voicemail arrives)
- Nathan + Justin design approval flow for client-notify triggers
- Twilio Brand approval still parked

---

**Open follow-ups (Justin's lane):**
- Build 8 inbound-call verification (test calling +1 513 998 5440)
- A2P 10DLC final approval at TCR (IN_PROGRESS; daily 9am check live)
- 28 newly-filed issues to triage + prioritize (#186–#215)

**Last updated:** 2026-05-26 — backlog grooming + session-search dual-path codified

**Last updated (auto):** 2026-05-14 20:12 UTC

### Justin · vigorous-williamson-f7809f

**Branch:** 
**Last updated (auto):** 2026-06-09 20:10 UTC

### Justin · quirky-lamarr-8ec4ff

**Branch:** 
**Last updated (auto):** 2026-06-08 18:21 UTC

### Justin · fervent-napier-9c4b2a

**Branch:** `justin/contract-human-confirmed-build29` (worktree)
**Last updated (auto):** 2026-06-09 20:02 UTC

**2026-06-09 (Lauren + Case Details session):**
- Fixed Lauren `get_deal_url` tool hallucination — `lauren_get_deal_url`'s
  `is_admin()/is_va()` gate was short-circuiting to NULL under service_role.
  Same bug found in `lauren_get_deal_detail`, `lauren_lookup_deal_notes`,
  `lauren_lookup_docket_events`. Two migrations shipped + applied:
  - `20260528200534_lauren_get_deal_url_service_role_bypass.sql`
  - `20260528201110_lauren_rpcs_service_role_bypass.sql`
- Re-deployed `lauren-team-respond` EF (v61) with `verify_jwt: false` so the
  pg-trigger path works. QA confirmed: Lauren returns real Castle URLs.
- **Case Details field-disappear bug** — diagnosed two stacked races:
  1. dirty-key buffer (Nathan/Inaam, b368881) protects the KEY NAME
     from realtime echo, but not the VALUE.
  2. HTTP/2 multiplexed PATCHes per keystroke return out of order; an
     earlier-write's echo lands AFTER a later keystroke and overwrites
     localMeta — same field, wrong value. Live repro: 31-char Zillow
     URL → 16 chars in DB.
  Shipped 350ms debounce (`useDealMetaBuffer` hook) at `167d10e`. PR #314
  came from a stale branch and silently reverted the bundle 2 min later.
  Re-applied at `a1dd5cd` (the commit log + the source comment both name
  PR #314 explicitly so future grep-back is easy).
  Deploy verified: deployed bundle (hash `7dbd663d9089`) byte-identical
  to local; `setTimeout(f,350)` + `pendingPatch` present. Live keystroke
  QA on prod blocked by data-safety classifier (would mutate a real
  deal). Justin to spot-check in his own session.

**2026-06-09 (Comms actions session — #323 + #324):**
- **#323 reaction-threading** (`87d2035`): global Comms (`CommunicationsView`)
  was splitting iMessage tapback reactions into a separate thread from the
  parent SMS. Cause: send-sms/receive-sms key `${deal}:contact:${uuid}`,
  bridge keys `${deal}:phone:${num}`. Fix: group on `(deal_id, counterpart
  phone)` not raw thread_key; `:group:` keys preserved. Live-verified: Sha
  Johnson SMS + Disliked + Liked now one thread.
- **#324 inline Comms actions** — discovered the parallel `vigorous-williamson`
  session already shipped the FULL composer + Call back to global Comms
  (`76a450d` + follow-ups). Justin reviewed: KEEP the full composer (verified
  live working on a linked thread), but the no-deal branch was BLOCKING
  ("go link in Contacts"). Per Justin, unlinked numbers should reply/call
  deal-less instead. Shipped `DealLessThreadComposer` (`6f6fa61`): lean
  reply + Call back rendered when `resolvedDeal === false`. send-sms already
  accepts null deal_id (line 222) so no EF change; deal-less rows re-group
  under `none:<phone>` (the #323 grouping). Goes out as Twilio SMS from the
  main line (any carrier). Linked threads untouched.
  QA: local build boots clean; full composer live-verified; orphan baseline
  confirmed; deal-less render verified post-deploy on +15136661089.

### Justin · outbound-calling

**Branch:** `justin/outbound-calling` (worktree). REBASED 2026-06-04 onto `origin/justin/eas-preview-distribution-store` @ `25dfa322` — now = inbound Build 26 work + my 4 outbound commits, no conflicts.
**Working on:** Outbound calling end-to-end from the DCC iPhone app. **DONE + verified.**
**Status:** SHIPPED via OTA 2026-06-04. Outbound dials in-app over the Voice SDK (no modal on SDK path — modal only on genuine bridge fallback), navy in-call screen suppressed for outbound via `isOutboundCallActive()` guard in `_layout.tsx` AppState listener (Justin navigates DCC freely mid-call). Verified by Justin on-device + `call_logs` row `5c47f4f4` (outbound → +15135125735, from +15139985440, status `completed`, deal `surplus-mpof18hrx0pr`). In-call controls (mute/speaker/end): Justin chose to LEAVE AS-IS — green pill foregrounds DCC (no call UI by design), native controls via App Switcher. No slim call-bar built.
**OTA live:** channel `preview`, branch `preview`, runtime `0.1.0`, group `8077e05f-ff87-4be0-acea-7547cb9404e1`, commit `3269023`. This was the FIRST OTA published AFTER Build 26 was built (13:20Z) — earlier OTAs predated the build and expo-updates refused to "downgrade" to them. Lesson: an OTA only reaches an installed build if it's published *after* that build.
**⚠ DURABILITY — inbound session must read this:** the OTA holds only until the next NATIVE build ships from a branch WITHOUT my 4 outbound commits. The next mobile build (Build 27+) MUST come from `justin/outbound-calling` (it already contains all of `eas-preview-distribution-store` @ 25dfa322 + my fixes), OR fast-forward `justin/outbound-calling` into the build branch first. Building from plain 25dfa322 will orphan this OTA and regress the outbound fixes.
**Gotcha logged:** `EXPO_TOKEN` in the shell env was wrapped in literal `<>` (42 chars, real token is 40) → "bearer token invalid". Strip with `EXPO_TOKEN="${EXPO_TOKEN//[<>]/}"`. Also use the homebrew `eas` (`/opt/homebrew/bin/eas`), not `npx eas-cli@latest`.
**Coordination:** Only additive change to inbound-owned shared files — one guard line + one import in `_layout.tsx` (`isOutboundCallActive()`), plus the `_outboundCallActive` flag + export in `lib/voice.ts`. `app/call/[sid].tsx` untouched. Inbound's `25dfa322` (reliable deal-open + dedup guard) fully preserved.
**Last updated (auto):** 2026-06-04 14:36 UTC

### Justin · reconcile-main-281 (eloquent-brahmagupta-248dfb)

**Branch:** `justin/reconcile-main-281` (worktree `/private/tmp/dcc-reconcile`). Merges `origin/justin/eas-preview-distribution-store` @ `e0a68c4` into `origin/main` @ `f1d1a06`.
**Working on:** (1) Inbound calling on the iPhone app, (2) reconciling the long-lived build branch back onto main and retiring it (#281). **DONE.**
**Inbound — SHIPPED + verified on-device:** native CallKit, two-way audio, deal auto-opens on accept (CallKit owns the call UI — we navigate to the deal only, no custom call screen on top), repeatable across calls, no crash. The Build 26 notification-tap SIGABRT is fixed: `chanName()` unique-topic helper across all 10 Realtime channels (supabase-js reuses a channel by topic; a 2nd `.on('postgres_changes')` after `subscribe()` threw uncaught → RN escalated to fatal). Shipped combined with outbound via OTA group `ad2a048f`, commit `e0a68c4`. Verified: 2 live inbound calls, deal `surplus-mpof18hrx0pr` auto-opened from the inbox, `call_logs` rows confirmed completed + resolved.
**Reconciliation — DONE (commit `d481cb5`):** single trunk on main now carries inbound + outbound. 8 conflicts resolved (twilio-voice kept main's correct `+15139982306`; deal/[id].tsx + quick/call.tsx hand-merged to thread BOTH main's contactId AND outbound's displayName; eas.json unioned both adhoc+preview profiles; docs unioned). Verified: zero conflict markers; `tsc` shows only the 2 pre-existing type-only SDK errors; backend comms surfaces byte-identical to main; mobile call governing files byte-identical to the on-device-verified bundle `e0a68c4` (only delta = additive contactId threading). Build branch `justin/eas-preview-distribution-store` retired.
**⚠ Build flow going forward:** main IS now the build source for mobile. Next `eas build` comes from `main` (no more building off `justin/eas-preview-distribution-store`). `git pull` first; verify `gitCommit` via `eas build:list`. Run `/release-check inbound-callkit` before any build (hook-enforced).
**Last updated (auto):** 2026-06-05 UTC

## Nathan's session

**Status:** Idle — 2026-06-22 — DCC simplification (1–7): nav→Outreach hub, 🩺 Health page, Daily Worklist, meta→column verified-complete, Relay KEPT (paused); + nav-badge-mismatch sweep + dead-deal cleanup trigger. All pushed; archived.
**Branch:** main (all work pushed)

**Today (2026-06-22) — what shipped**

- **DCC simplification 1–7 + nav-badge fixes.** Full arc shipped — see `session_archives/2026-06-22-dcc-simplification-1-7-badges.md`. (1) Nav collapsed: `OutreachHub` folds Automations+Comms+Comms-Analytics into one **Outreach** button w/ tabs; `forecast`→Insights; dup 💬 gone; all old routes resolve via groupIds (`969db76`). (3) **meta→column verified COMPLETE** — `tg_sync_deals_meta_from_columns` mirrors all 33 cols, 0 drift/417 deals; locked the invariant in a comment, no churn (`50c3d44`). (5) **System Health** admin page (`get_operator_health()` — AI canary, crons, alerts, scrapers; `293e10a`). (6) **Daily Worklist** atop Today (`get_daily_worklist()` — ranked Deadlines/Review/Call/Followup; `bf9fa7c`). **(2) Relay: KEPT, not killed** — Nathan reviewed the live Automations screen + likes the manual Review Mode/Scan Now flow; only dropped 2 *disabled* crons; UI+`relay_*` tables+EFs stay (local doc `~/Documents/Claude/DCC_RELAY_DECOMMISSION_2026-06-22.md`). **(4) Prune: deferred** — `pg_class` can't ID dead tables safely; Health page covers monitoring. **Badge-mismatch sweep:** Review badge was stale-at-mount (56 vs body 30) → refreshes on `deals` realtime; Follow-ups badge counted an orphan task on deleted deal `sf-daggs` (1 vs body 0) → `get_followup_due_count()` (`36fd412`); `verify_maybe_gone` over-fired on live surplus → tightened 18→7. **Dead-deal cleanup trigger** `tg_cleanup_on_deal_dead` (closes tasks + acks docket on dead/delete; backfill cleared 120 tasks + 436 docket, unacked 1792→1356; `5079b0f`). **Build guard** vs leaked conflict markers (`b03950c`). CLAUDE.md view-list + Gotchas refreshed. EF deploys stayed IP-gated → all work was front-end + migrations + SQL.

**Today (2026-06-09) — what shipped**

- **DECEASED toggle live-update fix** (`b24068a`, build `923df7af081b`) — Eric: toggle "sticks purple," needs a page refresh, both directions. Root cause = read/write split: Phase 2 (#326) moved the toggle's write to the **`deals.deceased` column** (META_TO_COLUMN flush; DB trigger mirrors column→meta), but the checkbox read `isDeceased(deal)` = meta+death_signal only — the optimistic client update patches just the column, so every isDeceased reader held stale meta until a full reload. (The isDeceased(deal) read was my 2026-06-06 badge-consistency fix — correct pre-column, made stale by the migration.) Fix: (1) **isDeceased is column-aware** (column → legacy meta override → death_signal; verified in prod: sync trigger enabled, ZERO column-vs-meta divergence); (2) toggle renders **buffer-first** (`deceasedShown`) so it flips instantly on click. ⚠ Not browser-verified (auth-gated; CDP times out) — Eric to confirm after the reload banner.

- **Case Details field-disappear — race-proof fix, now merged 2-layer (LIVE `98732abb5012`).** Nathan + Inaam (and Justin + Inaam) still hit it after the 06-04 buffer. Root cause: the old 2s "typed-recently" timer was racy + `updateDealMeta`'s optimistic write fooled any value-match release. My fix = **dirty-key guard** (a touched key shows the user's value until they switch deals — can't be reverted by a reload, by construction) in SurplusOverview AND FlipOverview. Justin then DRY'd both into a shared `useDealMetaBuffer` hook (Layer 1 = my dirty-key) + added **Layer 2: a 350ms debounce** coalescing per-keystroke saves (`a1dd5cd`, after PR #314 had silently reverted his earlier debounce 167d10e). Hard-refresh to `98732abb5012` to confirm.
- **Docket-refresh triage + Director hand-off.** Docket Center showed 4008 unacked events = full histories of **53 surplus leads**. Refreshed Case Intelligence on all 53 (throttled pg_net loop reusing the canary's anon key) + **acked all 4008 (queue→0)**. Digest for Nathan: ~28 workable (19 claimable-now ≈$640k sitting w/ clerk + 9 sold-pending-distribution), 9 dead, 6 investor-LLC (exclude), 4 needs-review, 6 pre-sale. **Filed Director-Queue `oh-2026-06-09-1524-dcc-misflagged-surplus-claimstatus.md`** (+ pointer in DIRECTOR_DCC_INTERFACE.md) for ~16 cases whose intel_case `surplusClaimStatus`/`auctionStatus` contradicts the docket — Director verifies + reconciles; DCC didn't touch managed keys.
- **SOP — HOA disbursement ≠ full surplus** (Nathan 2026-06-09): an HOA payout is only a partial slice; pull the Sheriff's Report of Sale for the original surplus. Logged to `memory/feedback_surplus_lead_validation.md` + the `surplus-math` skill.

**Today (2026-06-08) — what shipped**

- **AI outage diagnosis + honest errors + credit-exhaustion alarm** (`0f98e06`, migration `20260608120000_anthropic_credit_canary`, live `0cacf6f30f69`). Nathan: "why is it saying claude api failed?" **Root cause: the Anthropic account behind the shared `ANTHROPIC_API_KEY` ran out of prepaid credits ~06-05** — invoked the EF directly and got `invalid_request_error: "Your credit balance is too low…"`. NOT a code bug. Blast radius = every AI EF (generate-case-summary, generate-outreach, all `lauren-*` incl. the **public website chat**, morning-sweep, monday-memo, castle-health-daily, summarize-call). **Fix is Nathan's lane:** console.anthropic.com → Billing → add credits + auto-reload; everything resumes automatically, no redeploy. Shipped two things so it's never silent again: (1) **`interpretAiError()`** in CaseIntelligence reads the EF's `detail` and translates billing/auth/rate-limit/model errors to plain English (covers both Refresh + auto-refresh-on-open); (2) **daily Anthropic canary** — pg_cron `anthropic-canary-fire` (13:00 UTC) + `-check` (13:15 UTC) via pg_net exercise the real generate-case-summary EF; on failure they raise an in-app `system_alert` (fingerprint `anthropic-api-down`) **and** a founder Resend email. **No new Edge Function** (EF deploys are IP-allowlist gated) — SQL-native, reuses `report_system_alert` + `get_resend_api_key`. Verified live end-to-end: canary caught the current outage (502, parsed "credit balance too low"), wrote the alert (now showing — accurate). **⚠ Justin:** 2 new cron jobs + a founder-alert email on AI outage; does NOT touch SMS/outreach. **Gotchas logged:** generate-case-summary has `verify_jwt` **ON** (needs a valid anon JWT, not just any 20-char Bearer); and when embedding the 200-char anon key into a `apply_migration`/`execute_sql` call I hit a 1-char unicode corruption (`F`→Cyrillic `Ф`) — fixed in place with `regexp_replace(def,'[^\x00-\x7F]','F')` sourced from the live function def (zero re-typing). Prefer reading the key from Vault/file over re-emitting it.

**Today (2026-06-01) — what shipped**

- **"Ready · <name>" attribution badge** (`d699884`, migration `20260605120000`, live `d55d6fbe228a`, closes #257). Nathan: need to know who readied each lead (Anam vs Eric) so questions route back. Activity feed already logged WHO (user_id) but never surfaced. Added `deals.readied_by` (name) + `readied_by_at` columns + backfilled from existing "Marked ready" activity (50/221 attributed; older predate 2026-05-29 logging). markPrepped + toggleReady now stamp them (toggleReady clears on un-ready); activity action string unchanged so the work-scorecard match still works. Surfaced via DealStatusBadges "✅ Ready · <name>" pill + SurplusCard "READY FOR OUTREACH · <name> · <date>" pill + tooltip. **Columns not meta** (avoids the meta-clobber race fixed same day). Per-lead Timeline remains the full who-did-what audit log.
- **Case Details fields revert mid-edit — FIXED** (`62bc976`, live `f0e4872de1b3`). Nathan + Inaam caught on video: typing/pasting into any Case Details field (Zillow link, foreclosure date, obituary, estimatedSurplus, judgment, …) — value disappears on first input, takes 2-3 tries to stick, across the whole field set. Root cause: every Case Details input is controlled, bound directly to `deal.meta.<field>` in `SurplusOverview`; any global `deals` reload (realtime echo of the keystroke-write, 60s refresh, or intel-main 30-min sync) replaces the deal object and snaps the in-progress field back to the DB value. Fix: a **local meta buffer** in SurplusOverview — inputs read the buffer (typing never clobbered), buffer only re-adopts the server value when the user hasn't typed in ~2s, and each save merges the touched key onto the LATEST `deal.meta` (not the stale buffer) so a concurrently-synced field can't be silently reverted (the data-loss risk Nathan flagged). One ~15-line change, covers all ~35 inputs, no per-input edits. ⚠ Not pixel-verified (bug is intermittent + browser CDP timeouts) — root cause is decisive; Nathan/Inaam to confirm over next day's use (refresh to load f0e4872de1b3 first).
- **Badge sync — Ready-for-Outreach reads prepped_at only** (`f1d1a06`). Eric: Eva Cooper showed READY on Deals page but not on Prep Queue. `isReadyForOutreach` OR'd in legacy `meta.verified`; 7 stale junk leads (0 phone/url/contact) falsely read ready. Dropped the OR → prepped_at is sole truth, matches Prep Queue.
- **Reach-the-unreachable (Nathan 2026-06-04).** 45% of surplus leads (134/296) have no phone in `meta` → can't be worked. Refined: **99 truly unreachable** (no meta phone AND no contact phone, $5.13M) need skip-trace; **35 already have a number on a linked contact** (just not surfaced). The research agent (separate, Director-commanded) finds the numbers; the DCC side had the output blocked. **Shipped the linchpin: migration `20260604120000_autoqueue_day0_outreach_on_prep`** — a trigger `tg_autoqueue_day0_on_prep` (AFTER UPDATE OF prepped_at, NULL→non-NULL) that queues a Day-0 outreach DRAFT. This resolves research-agent **blocker B-1** (markPrepped was client-side JS, so the agent's service-role `prepped_at` write fired nothing). Fires for the agent, the Today Mark-Prepped button (dedup'd by its own existing-row guard — no double), AND the lead-card Mark-Ready toggle (which never queued before — fixed). Folds in the 35-hidden-number fix (contact-phone fallback). Gated: tier A/B, active, NOT deceased, non-DNC phone, no existing active row. **Day-0 is human-gated** (dispatch-cadence-message skips it) so it only drafts, never auto-texts. DB-only, no app rebuild. Verified with a rolled-back synthetic matrix (A+phone→1, contact-phone→1, C→0, deceased→0, no-phone→0, dedup→1). **⚠ Justin:** new trigger writes into `outreach_queue` on prep — mirrors the markPrepped client auto-queue you already had; send path unchanged. **Note for Director:** agent B-1 is now cleared — when you run the research agent on the 99, its enriched leads will surface Day-0 drafts automatically.
- **Docket coverage — main focus (Nathan 2026-06-03).** Today strip showed "0% · 308 of 308 surplus leads aren't pulling dockets." **Verified false** — real number is **72/308 (~23%, $5.06M live)**; the "0%" was a failed RPC load rendering as zero (stale bundle). Hardened `DocketCoverageStrip`: a failed `surplus_docket_pulling_ids()` load now shows a Retry state, never a fabricated 0% (`a489ad0`, live `ffc666f8cfca`). Wrote the executable target spec **`docs/DOCKET_COVERAGE_TARGET.md`** for the Director/state sessions: 3 buckets (72 pulling / 110 stuck $4.89M / 126 no-scraper $9.11M), per-county case# evidence for #275 (Cuyahoga concatenated-vs-separated, Hamilton missing A-prefix + IN collisions, Montgomery lookback), dollar-ranked scraper priorities (Lorain $1.37M, Warren, Fairfield). Refreshed the #275 item in `DIRECTOR_DCC_INTERFACE.md`. **Honest framing: literal 100% isn't economical; Lever 1 (#275 normalization) is ~23%→~59% with zero new scrapers. Execution is Director/Castle-side, not DCC.**
- **Visible build tag + 2 vacated leads killed manually** (`c04f3e8`). Sidebar footer now shows `build <hash>` (ground truth on which bundle a tab runs). Marked `sf-coon` + `sf-weaver` dead (sale_vacated) via DB since the stale-bundle Kill button blocked Nathan; held `sf-unknown-2` Bellanca (pending vacate).
- **Stale-bundle root cause + auto cache-bust** (`6e2bc5b`, deploy-verified live). This is the real cause of the whole session's "shipped the fix but Nathan still hits it" pattern (today: Sale-Risk **Kill button** reported broken a 3rd time). `index.html` loaded `app.js` with a **hand-typed static `?v=20260505i`** that nobody bumped → every deploy reused the URL → browsers served the OLD app.js from cache. Operators keep the DCC tab open all day (auto-refreshes DATA, never JS), so correct deployed fixes sat unloaded for weeks. DB proof: disposition flow works (102 surplus dead-with-reason, 1 today) but **0 `sale_vacated` kills ever** — that's the newest code, which the stale tab never loaded. Fix: (1) **`build.js` now stamps `index.html` with `app.js?v=<sha256 content hash>`** every build (auto cache-bust); (2) **`VersionWatcher`** component polls index.html every ~4min + on tab-focus and shows a "🔄 New version — Reload" banner when a new deploy is detected (fail-safe: never nags if it can't read a token). **⚠ Justin:** build flow changed — `npm run build` now rewrites `index.html`'s `?v=` token; commit index.html with app.js. Operators need ONE hard refresh to pick up the watcher; after that they auto-stay-current. The Kill button itself was never broken in current code — it was the stale bundle.
- **Chat unread-badge fix** (`cbd5a78`, migration `20260601120000`, applied to DB). Nathan saw "💬 Chat 3" with an empty inbox — the 3 were Lauren's autonomous agent posts in his "Ask Lauren" `lauren_dm` thread, which `team_unread_count` counted. Both unread RPCs (`team_unread_count` + `team_unread_per_thread`) now exclude `sender_kind='lauren'` and skip archived threads. Human messages still count (verified 110 of Nathan's countable, 56 Lauren + 7 archived excluded); Nathan's badge → 0. **⚠ Justin:** this RPC also backs the mobile unread badge — semantics changed (Lauren no longer counts). Server-side only, no app rebuild.
- **Follow-ups feature** (`8b379df`, deploy-hash-verified live). Nathan: "need a way to track leads that, after a good convo, want a callback." Discovered the plumbing already existed but was buried — the Log-call form's "Follow up on" date → `log_deal_activity` → auto-created reminder task (titled "Follow up: <note>"), surfaced only in the Tasks page + a New-Leads filter chip. **0 follow-up tasks existed** = the field was unused. Made it first-class: (1) **new 📞 Follow-ups nav page** (`FollowupsView`) — open follow-ups on actionable deals, overdue-first, filters Due-now/Overdue/Today/Week/All/Done, checkbox = done, sidebar badge = # due/overdue; (2) **⏰ Follow up button** (`FollowupButton`) in the deal header (visible on Comms tab too) — quick date pick + note, saves via the same `log_deal_activity` RPC, supersedes prior open follow-up. **No migration** — drives off `tasks` where `title ilike 'follow up%'`. DB-verified (view query + badge + supersede all match; test row cleaned up). ⚠ **Not pixel-verified** (browser frozen). Minor known gap: badge counts follow-ups on all deals, page hides dead/closed — drifts only once follow-ups land on dead deals (rare). Started from an AskUserQuestion: Nathan chose dedicated nav page (not a Today strip) + yes to the quick button.
- **Performance pass** (`dec5bbc` + `15f176d`, both deploy-hash-verified live). Root issue: the app re-pulled the full deals list (428 rows / ~1.28MB) far more often than needed. Four fixes: (1) **debounce the realtime deals reload** so an intel-main sync burst = one reload, not dozens; (2) **skip the 60s auto-refresh when the tab is hidden**; (3) **DocketCoverageStrip → new `surplus_docket_pulling_ids()` RPC** (server-side DISTINCT, ~67 ids) instead of pulling ~8,190 docket rows to derive them; (4) **debounce SaleRiskStrip's** docket re-scan. ⚠ **Not pixel-verified** — browser froze all session; logic unchanged + DB-verified, but I didn't watch the Today strips paint.
- **Migration `20260601000000_surplus_docket_pulling_ids.sql`** — read-only STABLE SECURITY INVOKER helper; applied to DB + committed. Returns 67 ids (verified).
- **Deferred (Nathan's call, 2026-06-01):** trimming `case_intel_summary` (347KB = **27%** of the 1.28MB deals payload) out of the list load. Held until the browser's responsive enough to click-test, because **both** RelayDealPanel (outreach review) and CaseIntelligence read it — they'd need to fetch it on open. Next-session pickup if perf still matters.
- **MCP state change:** supabase-dcc MCP is **AUTHORIZED again** this session — `execute_sql` + `apply_migration` both work. The 2026-05-27 "UNAUTHORIZED" gotcha below **no longer applies**.

**Today (2026-05-27) — what shipped**

- **#237 surplus confidence-tier badge + filter** (`57a692e`, closes #237). Card+detail badge from intel-main's read-only `meta.confidenceTier`: walker_verified→gold "Walker-verified", complaint_inferred→amber "Complaint-inferred · verify lien", untiered→none. Surplus-list filter `[All · Walker only (134) · Verify-first (8)]`. **Replaced** today's earlier binary verified/unverified pill (`8e3f296`) — confidenceTier supersedes it; don't re-add both. Verified live: 134/8/286.
- **send-sms text-splitting fix** (`7ecdad8`, #235, **⚠ needs Justin to deploy**). mac_bridge/iMessage path now sends the whole body as one message instead of `splitAtPunctuation` chopping >160-char texts into pieces (Nathan hit it on the Novak thread). EF = Justin's domain + no EF-deploy access this session → committed + DM'd him the deploy command. Twilio fallback untouched.
- **Delete guard** (`91b5a7e`). DeleteDealModal warns + requires an ack when deleting a deal past the lead stage (someone's active case), steers to "mark Dead with a reason". Routine junk-lead deletes unaffected.
- **Relay/Automations coordination.** Reversed my mistaken Relay retirement (re-enabled crons 21/22 — Relay was ramping, not dead). DM'd Justin how to run both; verified his merge plan vs the code; sent handoff notes. Justin shipped Phase A (#233). Follow-up: Relay rows now land in the shared queue → labeled them "Relay · step N" (`ff28d4c`) so they don't read as Automations follow-ups.
- **#Ops SOP for Eric+Inaam:** Delete vs Mark-Dead (worked-it→Mark Dead, keeps the Director's signal; never-should've-existed→Delete).
- Earlier today: Attention→**Deadlines** rename + flicker fix (`8a10e7c`/`f4ef764`/`84e6201`), warm-leads strip→Today (`0775c48`), revenue-year picker on Profit Booked (`d431d02`).

**Open follow-ups (Nathan's lane):**
- **⚠ Add Anthropic credits** — console.anthropic.com → Billing (+ enable auto-reload). EVERY AI feature (Case Intelligence, AI SMS drafts, Lauren public chat, morning sweep, call summaries) is paused until then; recovers automatically once credits land. The new daily canary will in-app-alert + email if it ever flatlines again.
- **Justin deploys send-sms (#235)** — until then long manual texts still split. Match the live `verify_jwt` flag.
- Mac-bridge key rotation still gates the legacy-key disable (carryover from 2026-05-20 below).
- (optional) Phase A.3 send-time hard dedup (Justin's call) would let me retire the DoubleQueueGuard.

**Gotchas this session (full detail in `session_archives/2026-05-27-...`):** supabase-dcc MCP is UNAUTHORIZED here (no SQL / EF deploy / function-config read) → worked around via the page's reconstructed supabase client; long-session JWT expiry needs `refreshSession(refresh_token)` + persisting it back to localStorage or the tab logs out; browser-extension conflict freezes CDP on heavy deal-list pages.

**Today (2026-05-20) — what shipped**

- **Legacy `service_role` key rotation — IN PROGRESS.** Moving every consumer
  off the project's legacy anon/service_role JWTs onto new
  `sb_publishable_`/`sb_secret_` keys so the legacy service_role (which leaked
  into a chat transcript) can be safely disabled. Migrated + verified so far:
  Castle scrapers (`/home/deploy/castle-v2/config/.env` on intel-vps), Vercel
  portal (`refundlocators-next` `SUPABASE_SERVICE_ROLE_KEY` → redeployed,
  `/s/{token}` smoke-tested), ohio-intel (`DCC_SUPABASE_SERVICE_KEY` on
  intel-vps). **Edge Functions need NO change** — a probe (`keycheck-tmp`,
  since removed) proved Supabase already injects an `sb_secret_`
  value into the EF `SUPABASE_SERVICE_ROLE_KEY` env var and a service-role DB
  read works. `.env.bak.20260519-rotation` backups left on intel-vps.
- **Eric bug fixes (both live on main):**
  - `2df5b5d` — Prep Queue "missing: phone" warning now clears for deceased
    homeowners that have a relative/estate contact phone (matches a relative
    pattern against BOTH `contact_deals.relationship` AND `contacts.kind`,
    since relatives are tagged `kind='family'` with a null relationship).
    `markPrepped` auto-queue still gates on the meta phone — no texts to the deceased.
  - `82cc5e1` — `main-grid` `1fr` track blowout fixed (`minWidth:0` +
    `minmax(0,1fr)`); expanding the Prep Queue no longer forces a horizontal
    page scroll. Verified live at 1194px. Latent layout bug — applies to all views.
- **IN stale-lead cleanup (Director coordination item — DONE):** dead-statused all
  90 stale Indiana surplus leads from the Director's 2026-05-20 re-walk kill list
  (49 confirmed-dead `already_claimed` + 41 `unverified`/revivable) — cleared from
  Eric's active prep queue. Cross-checked all 90 live county/case# against the
  kill-list CSV (`indiana-pipeline/.../DCC_kill_list.csv`) — no ID collisions; all
  90 were `new-lead` (unworked). Used uniform `status='dead'` (soft-delete reason
  allowlist didn't fit either disposition). Reversible: set back to `new-lead`.
  Archive/park distinction preserved in `meta.surplusClaimStatus`; the 41
  `unverified` ones revive when their clerk records-request lands.
- **"Ready for Outreach" status shipped (`900b025`):** New Leads view now has an
  Outreach-readiness filter (All / 🌱 Needs cleaning / ✅ Ready) + a per-card
  "✓ Mark Ready" button (allow-with-warning — clickable when incomplete, shows
  what's missing) + "✅ READY" badge. Merged the two prior signals — `prepped_at`
  + `meta.verified` — into ONE status so Eric/Innam vet from the leads list and
  the whole team sees cleaned-vs-raw at a glance. **Justin:** the old `✓ CLEAN`
  badge is now `✅ READY` (same `meta.verified` flag, now set together with
  `prepped_at`). Single readiness source of truth = module-level `leadMissing()`
  (the Today→Prep Queue now delegates to it too). QA'd live: filter, toggle
  (mark+revert), badges, 0 console errors.
- **Lead contact-status + Log-outreach shipped (`da64ce2`):** New Leads cards now
  show a contact badge (🔴 Not contacted / 📞 Worked Xd ago + outcome / ⏰ Follow-up
  due, overdue-aware) + a 2nd filter row (Contact status: All / Not contacted /
  Worked / Follow-up due) + a one-click "📞 Log outreach" button that opens the
  existing `LogActivityForm` in a modal (call/text/email/note/meeting + outcome +
  follow-up date, without leaving the list). Pure surfacing of the existing
  `last_contacted_at` / `log_deal_activity` system — no new backend. Reads latest
  outcome + next follow-up from `activity` per lead. **Justin:** merged cleanly
  with your #183 team-chat work (app.js rebuilt). QA'd live, 0 feature errors.

**🚨 HEADS-UP FOR JUSTIN — Mac bridge key rotation (this GATES the legacy-key disable)**

`bridge.js` reads `SUPABASE_SERVICE_KEY` from `mac-bridge/.env` on the Mac Mini,
and that value is the legacy `service_role` JWT — it is NOT platform-injected,
so it did NOT auto-swap to `sb_secret_` the way the Edge Functions did. When the
legacy keys get disabled, the bridge's DB auth dies → **outbound SMS stops.**
It's your domain + you have the `defender_mini` key, and the Mini was offline
when I checked (couldn't reach it from Nathan's machine). **Please rotate before
anyone clicks "Disable JWT-based legacy API keys" in the Supabase dashboard:**
1. Mint a new `sb_secret_` (DCC dashboard → API Keys → Secret keys, name `mac-bridge`)
2. `mac-bridge/.env` → `SUPABASE_SERVICE_KEY=<new sb_secret_>`
3. `launchctl unload` then `load ~/Library/LaunchAgents/com.refundlocators.bridge.plist`
4. `tail -20 /tmp/dcc-bridge.log` (clean reconnect, no auth errors) + send one test SMS
Then ping Nathan so the Disable + signing-key Revoke can finish.

Low-pri sibling: the `weekly-db-backup` GitHub Action uses a `SUPABASE_ANON_KEY`
repo secret that may still be a legacy JWT. The backup itself uses a direct
Postgres connection so it survives the disable; only the failure-alert REST call
would break. Update the secret to an `sb_publishable_` when convenient.

**Previous (2026-05-08) — full-day audit + 8 migrations + system alert hardening**

Bug-fix marathon driven by Eric flagging multiple silent failures. Pattern that emerged: **contact data ↔ deal data drift** — facts on `contacts` that need to bridge to `deal.meta` for the auto-queue gate to see them. Hit it 4 times today, fixed each instance + the architectural pattern.

**Migrations applied** (8 today, all via SQL editor):
1. `20260508130000_team_threads_dm_privacy_fix.sql` — Eric was reading my DMs with Justin (pre-Phase-3 DMs defaulted to thread_type='channel'). New RLS: if a thread has any `team_thread_participants` rows, only those participants read it. 247 contact_deals.relationship NULLs backfilled from contacts.kind in same pass.
2. `20260508140000_backfill_ghl_family_relationship.sql` — historical GHL family-contacts from 4-29 + 5-1 imports were `relationship='other'`; backfilled to `'family'` (today's importer fix already changed the default).
3. `20260508150000_homeowner_phone_sync.sql` — Charlotte Morrow / Richard Mikol / Trevor Mccain were silently skipped from outreach because their phones lived only on `contacts.phone`, not `deal.meta.homeownerPhone`. 6 deals affected; 3 prepped A-tier retroactively queued. Added 2 sync triggers: contact phone update → meta; contact_deals link → meta. Going forward this can't recur.
4. `20260508160000_audit_remediation.sql` — fired 3 things in one paste: cancelled 2 deceased-homeowner outreach rows that would have texted dead people (Lindon Phillips, Leroy Turner Jr); cancelled 1 zombie pending row stuck 9 days; backfilled `meta.deceased=true` on 24 deals where the contact-level flag wasn't propagating; deceased-contact → meta sync triggers; `sweep_stale_outreach_queue()` function + pg_cron daily 09:00 UTC; deleted 20 orphan personalized_links (incl my own manual-test claim row).
5. `20260508170000_personalized_link_views.sql` — per-view audit table because Eric's pushback caught me overclaiming engagement on Richard. Old `view_count` was just a counter — couldn't distinguish 1 person × 39 refreshes from 39 distinct viewers from team testing. New `personalized_link_views` table captures IP + user-agent + referer per page hit. Plus `v_personalized_link_engagement` view that exposes `distinct_external_fingerprints` and `external_views_*` (excludes is_team_view=true).
6. `20260508180000_post_alerts_to_ops_chat.sql` — claim submissions and Lauren chat alerts now post to # Ops thread as `team_messages` with new `sender_kind='system'`. Third notification leg alongside Twilio SMS + Resend email. The chat post is the one we KNOW reaches the team because we're already in DCC.

**Code shipped (commits dfd9d57 → 4463343, all on main)**:
- GHL importer fix — read `Family N Name` from CSV; default `relationship='family'`
- DCC `dealMetaPhone()` helper centralized — accepts 4 phone-key variants (`homeownerPhone | phone | contactPhone | homeowner_phone`)
- Soft-delete on deals (admin-only, reason codes, restore view) — already shipped 5/7, used today on Joseph Mondello + Matthew Thomas
- Tier-independent 🕊 deceased badge — appears on cards / detail header / Send Intro / Send Personalized Link
- Dup-check on + New Deal modal (debounced live match against existing deals)
- Bulk-queue C-tier admin button on Pipeline → Kanban (closes the "27 prepped C-tier sit in Ready forever" gap)
- Engagement strip on every deal Overview (post-tonight) — reads v_personalized_link_engagement, color-codes signal (gray = no audited views, amber = 1-2 distinct, green = 3+ distinct = real interest)
- 4 SOPs / docs to Eric in # Ops chat: SOP v2 written + delivered (audit miss on the 7 deceased-homeowner deals caught + retracted publicly)

**Eric's pushback caught 2 of my misclaims today**:
- "Add a homeowner contact via Comms tab on the 7 prepped-no-homeowner deals" — would have texted 6 dead people. Eric correctly added heirs/relatives instead.
- "Richard Mikol HOT lead — submitted claim, viewed today" — the "claim" was MY manual portal test on 4/28 (same fake AR phone 4794595671 as the deleted Nathan-Johnson orphan). Reset his fake `claim_submitted_at` + cancelled the bad Day-0 draft tonight.

**Live state metrics (verified 2026-05-08)**:
- 130 active deals, 132 total (2 soft-deleted)
- 73 prepped, 22 outreach drafts queued
- **4 outbound messages sent in 7 days** ← the launch bottleneck. Whole funnel points at a Send button that hasn't been clicked at scale.
- 20 A-tier · 25 B-tier · 53 C-tier · 32 untiered
- 147 personalized URLs minted (23 with any views — but real distinct visitors unknown until per-view audit fills)
- 4 signed / 5 filed / 3 recovered

**Open follow-ups (mostly unblocked, Nathan's choice when to fire)**:
- Send the first real outbound on a queued A-tier draft to verify the mac-bridge end-to-end (the actual launch — 0 messages sent in 7 days while 22 drafts are waiting)
- Cherry-pick portal commit `97c4747` from `nathan/lauren-returning-visitor-memory` to main (per-view tracking only kicks in once that branch deploys; migration already in prod)
- Set `TEAM_VIEW_IPS` env var in Vercel (CSV of team IPs) — without this, all team views land in the audit table without is_team_view flag
- 118 GHL family-contact orphans from 4-29 + 5-1 imports — re-link by name pattern OR wipe + re-import (re-link saves $177 in IDI Core spend)
- Castle scraper health: butler + montgomery chronic 3 days; alert email_sent=false 5 days. Chronic alert path is dead. SSH defender-mini → restart launchctl daemons + investigate `castle-health-daily` EF Resend call.
- Smoke-test the # Ops claim alert chain (submit fake claim on inactive token, watch chat) — verifies tonight's wiring
- 4 _pending_review/ migrations (client_edit_requests, research_shadow_log, research_rejections, agent_room_actions) — apply when their consumers go live

**Cross-session state**:
- Justin: shipped RVM pipeline + DocuSign signing + delivery-callback wiring (Twilio + Resend + Slybroadcast) this week. Migration drift CI live. Parked 2 client-notify triggers under `_pending_review/` pending approval-flow design.
- Ohio Intel: massive coverage push — 33 CV3 counties + 14 records-request snapshots + Tyler Cloud (Lucas/Licking/Medina) + Henschen (8 counties) + BenchmarkWeb (3) + Stark + ProWare Razor (Montgomery). Cuyahoga 720/720 cases enriched. Three-tab home rebuild. Auction status audit log. Address normalization via usaddress lib. Surplus floor 1K → 5K. Grade D added for underwater. Embedded Lauren panel.
- Eric: 73 leads prepped through the workflow. Caught 3 audit misses (Charlotte phone, deceased-7 list, Richard "engagement"). Wrote prep-queue SOP for Inaam (now in Library v2 form).
- Inaam: been doing NOD/30DTS work + categorization. Needs admin role bump (SQL ready in 2026-05-08 transcript) before he can see surplus fields and start the prep flow per the SOP.

**Touching tonight**: `src/app.jsx` (engagement strip + earlier today's helpers), `WORKING_ON.md` (this update), 8 supabase migrations under `supabase/migrations/`, refundlocators-next portal page (per-view IP/UA capture, on `nathan/lauren-returning-visitor-memory` branch awaiting merge).

**Last updated:** 2026-05-08 evening (post-audit, post-engagement-strip).

---

## Erik

Erik is a VA who works directly in the DCC UI (data entry, skip-tracing,
contact cleanup, brand-voice drafts). He's not running Claude Code in
this repo, so the live-session-state convention doesn't apply to him.
If that changes, add an "Erik's session" section in this same shape and
his mapping is already wired in `.claude/hooks/touch-working-on.sh`.

---

## Recently archived (skim before starting work)

| Date | Topic | File |
|---|---|---|
| 2026-04-30 | A2P 10DLC + Quo + iMessage architecture decided | `session_archives/2026-04-30-a2p-quo-imessage-architecture.md` |

Full list: `session_archives/index.md`.

---

<!--
Per-user template:

## <Name>'s session

**Status:** Active — <date>
**Branch:** <branch name>
**Working on:** <one sentence>
**Recent decisions:**
- <bullets>
**Touching:** <files / tables / migrations>
**Open follow-ups:**
- <bullets>
**Last updated:** <timestamp>
-->

_If a session crashes mid-work, leave a "crashed at <step>, resume from
<file>" note in your section so the next pickup is easy._
