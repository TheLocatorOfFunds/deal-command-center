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

**Status:** Active — 2026-05-26
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
**Last updated (auto):** 2026-05-26 17:13 UTC

### Justin · quirky-lamarr-8ec4ff

**Branch:** 
**Last updated (auto):** 2026-05-27 20:06 UTC

## Nathan's session

**Status:** Active — 2026-05-20 — legacy service_role key rotation (in progress) + Eric bug fixes
**Branch:** main (all work pushed)

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
