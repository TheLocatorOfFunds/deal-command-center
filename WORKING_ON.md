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

**Last updated (auto):** 2026-05-01 15:31 UTC

## Nathan's session

**Status:** Active as of 2026-04-29 evening. CSV importer cycle finished
(B-leads CSV in DB, 30 deals). Cleaning up data fields + UX polish. New
Claude Code session prep.

**Just finished (chronological)**:
- Per-contact personalized URLs (`/s/charlottemorrow-katherine` etc.) with relationship-aware copy on the rendered page (refundlocators-next), OG image, and iMessage preview
- Sale Date / Sale Price / Judgment Debt fields in Case Details (deal Overview) — admin-gated
- 30-Days-to-Sale (`is_30dts`) + 🔥 badge
- Deceased flag (`contacts.deceased` + UI toggle in contact editor) + 🕊️ pill on Comms tabs (with strikethrough)
- Account Settings: phone made optional, owner-only (Nathan + Justin) Team Access section to promote VAs to Admin in one click
- 📥 Import modal — CSV importer with three-way decision per row (Create / Merge audit / Skip), auto-dedup by case#/address/phone, handles GHL rich-export header signature, batched executes with progress + per-row error log
- Date timezone bug fixed (`parseAuctionDate` is now manual regex, no `Date()` for date-only strings)
- Family contact insert bug fixed (was spreading `relationship` into the `contacts` insert; column doesn't exist there)
- Insert order refactored: contact → deal → contact_deals + cleanup-on-fail at every step (no more orphans)
- Merge mode: re-uploading the CSV audits existing deals, fills any null fields, adds missing family contacts + GHL notes
- Acknowledge ALL docket events RPC + UI (the modal button now bulk-clears 1811 events in one statement)
- Tier-based name color on deal headers (A=green, B=red+🕊️, C=neutral)
- Comprehensive Case Details card form fields — every CSV column has a corresponding editable input on the deal Overview, organized into Lead Classification / Case Identity / Financial / Sale & Timeline / Liens / Attorney & Fees / Links / Source

**Active gaps Eric is hand-cleaning**:
- Sale dates on the first 22 imported deals are off by one day (TZ bug from older importer build). Eric is correcting them manually OR Nathan can clear `meta.saleDate` for `source='ghl-import'` and re-merge to backfill.
- Family contact relationships are all `'other'` from import — Eric's labeling them as `child`, `spouse`, etc.
- 0 family contacts on the 30 imports (the bug-era version dropped them silently). Re-uploading the same CSV in Merge mode will add them.

**Up next**:
- C-leads CSV import (queued — ready when Eric is)
- Cloudflare audit completion (Pages project + Maps key restriction)
- Obsidian vault v0 bootstrap
- Phone-type detection (parked, not yet built)

**Touching**: `src/app.jsx`, `supabase/migrations/`, `docs/IMPORTING_LEADS_FROM_GHL.md`, `TRANSFER_TO_NEW_CLAUDE_CODE.md`

**Migrations applied 2026-04-29**:
- `20260428090000_contacts_deceased.sql`
- `20260428100000_profiles_phone_nullable.sql`
- `20260429120000_acknowledge_all_docket_events.sql`

**Last updated:** 2026-04-29 evening.

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
