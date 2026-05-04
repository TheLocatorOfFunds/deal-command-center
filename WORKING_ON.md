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

**Status:** Active — 2026-04-30 (afternoon)
**Branch:** `chore/session-state-system` (this PR)
**Working on:** Standing up the live session-state convention — restructuring
`WORKING_ON.md`, creating `session_archives/`, updating `CLAUDE.md` so Nathan's
and Erik's sessions can see what each Claude is doing in real time.
**Recent decisions:**
- A2P 10DLC + Quo + iMessage architecture finalized — Mac bridge stays primary
  SMS, Twilio Brand parked, Quo voice-only, GHL/HighLevel transfer dropped.
  Full archive: `session_archives/2026-04-30-a2p-quo-imessage-architecture.md`.
**Touching:** `WORKING_ON.md`, `CLAUDE.md`, `session_archives/*`
**Open follow-ups:**
- Twilio Brand approval (1-3 days, parked state — no action)
- Decline Quo SMS A2P upsell email
- Erik onboarding (separate task)

---

**Last updated (auto):** 2026-05-04 20:27 UTC

## Nathan's session

**Status:** Active — 2026-05-01 (afternoon) — three PRs merged today + surplus pipeline scaffolding live.
**Branch:** main (no in-flight branch)
**Working on:** (1) Audited all 110 active deals (75 GHL imports + 35 other recent), bulk-minted 72 homeowner personalized URLs, briefed Eric in his DCC DM thread. (2) Fixed Eric-misses-DMs gap with persistent banner + animated badge + clear-all-on-engage (PRs #35, #37). (3) Made the 2026-05-01 architecture call on surplus pipeline (extends DCC, doesn't get its own Supabase) + scaffolded `surplus_docket_events` table + `surplus-pdfs` bucket (PR #38 merged, migration applied). Removed redundant Estimated Loan Balance field along the way.

**Audit findings (75 GHL imports)**:
- 70 of 75 had no personalized URL minted (93%) — biggest blocker, now fixed for 72
- 17 untiered (bulk-queue gate skips them) — Eric's lane to set A/B/C
- 14 have `meta.homeownerPhone` but no synced textable contact row
- 36 missing sale_price; 65 missing surplus estimate; 12 missing sale_date
- 75 of 75 missing mailing_address — system-wide gap
- 285 contacts still labeled `other` (Eric labeling); only 1 GHL import has fully unlabeled contacts (his work is showing)

**Just shipped (data, not code)**:
- 72 homeowner `personalized_links` rows minted via DCC tab JS injection. URL nickname = `firstname+lastname`. All 72 sync'd back to `deals.refundlocators_token` via the existing trigger. PL row count went from ~37 → 109. Source field `dcc-bulk-mint-2026-05-01` for traceability.
- Skipped: 285 "other"-relationship contacts (need Eric to label first → second bulk-mint round) + 42 "homeowner"-labeled contacts (duplicates of deal-level URL).
- Eric briefing sent (team_messages row `91222175-…`) covering the vision, the per-lead checklist, the priority punchlist, and the going-forward QA flow. Edited later to swap "slug" → "URL nickname" + follow-up note.

**Just shipped (code, all merged to main today)**:
- **PR #35** — Persistent unread-chat banner: full-width red banner under the header on every view when `unreadChatCount > 0` and not dismissed. Click → opens chat. × dismisses (local). Reappears on next new message. Header 💬 Chat badge now pulses (`chatBadgePulse` keyframe) when unread > 0. Also removed the Estimated Loan Balance field (Judgment + Total Debt cover the math).
- **PR #37** — Unified notification clearing: `markAllChatRead()` at App level upserts `last_read_at = now` across all team threads. Wired into all 4 chat-notification entry points (banner click, header chat button, toast Reply, OS notification). Engage one surface → all surfaces clear.
- **PR #38** — Surplus pipeline scaffolding: new `public.surplus_docket_events` table + `surplus-pdfs` storage bucket. Per the architecture call: Castle / Ohio Intel surplus pipeline extends DCC's Supabase (separate bucket + table), no new project. PDFs land at `surplus-pdfs/<castle_case_id>/<filename>` via Castle's service-role uploads during scrape session. RLS admin-only. Migration `20260501100000_surplus_docket_events.sql`.
- Cache buster `app.js?v=20260430m` → `20260501a` → `20260501b`.

**Just landed (apr 30 batch — git log 634c2ce → f16ce1a, all on main)**:
chat black-screen fix (isOwner threading) · Lauren EOD-polish (`lauren-eod-polish` EF) · per-deal screen recordings + Lauren auto-summary (`lauren-recording-summary` EF, `screen_recordings` table) · chat unread badge + per-thread badges + Mark-all-read · top-right team-message toasts · PDFs on every docket-event UI + root-cause `attach-docket-pdf` (vault secret never set; EF refactored to drop check) · glass-box scraper health drill-in + 88+ `realsheriff_*` agents seeded · DealStatusBadges cluster on every card · `phone_intel` + `queue_phone_probe` RPC + Comms-tab UI · App-level RecordingContext + minimizable pill · active-call header pills (from chat 📹 markers, last 30 min) · editable per-contact URL relationship + Tier filter on kanban · team-chat paste + `tg_auto_queue_phone_probe` (124 backfilled) + EodReportsToday widget on Today · removed 88+-pill CASTLE SCRAPER ALERTS wall from Attention · honest probe states (queued/probing/stuck) + Reset + drag-and-drop + paste screenshots in Comms composer · in-DCC monitoring: `system_alerts` + `report_system_alert()` + pg_cron sweeper + ⚠ owner-only header badge + modal viewer (wired into `attach-docket-pdf` + `intel-sync`).

Cache-buster live: `app.js?v=20260501b`.

**Credential leak (action item for Nathan)**: the `supabase projects api-keys` CLI command printed the legacy `service_role` JWT into my transcript. Recommend rotating it in Project Settings → API → JWT-based API keys (legacy) → Disable. Coordinate with Castle first — their `config/.env` uses the legacy JWT today; move them to the new `sb_secret_*` key before disabling the legacy JWT or Castle's writes will fail.

**Uncommitted (in repo per previous-session note)**: `.github/workflows/weekly-db-backup.yml` + `docs/BACKUP_SETUP.md`. Weekly `pg_dump` → Cloudflare R2. Workflow committed but inert until Nathan populates 6 GitHub secrets — ask if he finished the SETUP doc.

**Cross-session blocked**:
- Justin lane (`JUSTIN_PHONE_INTEL_PROBE_SPEC.md`) — Mac bridge needs AppleScript probe + `send-sms` routing on `phone_intel.imessage_capable`. Until shipped, every probe sits `status='queued'`. UI is honest about it.
- Ohio Intel + Castle — scrapers must upload PDFs DURING scrape session (county portals are session-protected; `attach-docket-pdf` can't fetch-later). Per `project_docket_pdf_requirement.md` memory.

**Other state**:
- PITR parked ($115/mo); R2 backup ($5/mo) is the chosen path. PITR available at Supabase dashboard → Database → Backups → PITR if Nathan reverses.
- Eric hand-cleaning first-22 GHL imports (off-by-one TZ pre-5c762d7) + labeling family-contact relationships. Don't stack new imports on top.
- Cloudflare audit + Obsidian vault v0 — still pending.

**Touching**: `personalized_links` (72 INSERT), `deals.refundlocators_token` (72 sync via trigger), `team_messages` (2 INSERT in Eric's DM thread — briefing + notification-permission walkthrough), `src/app.jsx` + `index.html` (banner + animations + clear-all wiring), `supabase/migrations/20260501100000_surplus_docket_events.sql` (new table + bucket).

**Open for follow-up** (after Eric's QA pass):
- Round 2 bulk-mint for family-contact URLs once Eric labels relationships (285 contacts pending)
- Tier the 17 untiered GHL imports (Eric's call)
- Address the 14 "phone-in-meta-but-no-contact-row" deals
- Backfill sale_price on 36 deals
- Decide mailing_address strategy (skip-trace vs. soften copy)

**Last updated:** 2026-05-01 (after audit + bulk-mint + Eric briefing).

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
