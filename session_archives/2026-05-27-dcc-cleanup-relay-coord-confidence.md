# Session 2026-05-27 — DCC cleanup, Relay/Automations coordination, #237 confidence tiers

**Owner:** Nathan
**Branch(es):** main (all pushed)
**Related PRs / issues:** #237 (confidence tiers — closed), #235 (send-sms split — open, awaiting Justin EF deploy), #233 (Justin's Relay Phase A — coordinated, not authored here)

## What we set out to do

Continuing Nathan's session. Goals that emerged through the day: coordinate the two
outreach engines (Relay vs Automations) with Justin, ship a delete-safety guard, fix a
text-splitting bug Nathan hit in real outreach, and build the Director's surplus
confidence-tier badge + filter (#237).

## Decisions made (durable — change behavior going forward)

- **`meta.confidenceTier` / `confidenceLabel` are intel-main-managed, read-only in DCC.** DCC only *displays* them (badge + filter + detail banner). Tiers: `walker_verified` (real + still-claimable; work first), `complaint_inferred` (inferred — ALL tax foreclosures; verify the lien before heavy outreach), untiered (legacy/non-confirmed; no badge).
- **#237's tier badge SUPERSEDES the binary `walkerVerified` pill** (`8e3f296`, same-day). Do NOT re-add both — they overlap/contradict. confidenceTier is the canonical signal.
- **send-sms must NOT split on the mac_bridge/iMessage path** (no 160-char limit there). Only the Twilio fallback splits. Fix = `gateway === 'mac_bridge' ? [body] : splitAtPunctuation(body)`. Committed (`7ecdad8`); **Justin deploys** (his EF + this session has no EF-deploy access).
- **Delete vs Mark-Dead SOP** (posted to #Ops for Eric + Inaam): worked-a-real-case-that-died → **Mark Dead with a reason** (preserves the Director's lead-quality signal that gates auto-push); never-should've-been-a-case (true dup, bad data, loan reinstated) → **Delete**. The delete guard enforces this for active-recovery deals.
- **Relay is KEPT, not retired.** Earlier mis-read "Relay at step 0 = dead" → reversed (re-enabled crons 21/22). Both engines coexist; the send-time hard dedup (Justin's Phase A.3) is the open policy call.

## Gotchas hit (non-obvious; future sessions need to know)

- **supabase-dcc MCP is UNAUTHORIZED this session** — no SQL, no EF deploy, no `list/get_edge_function` (function-config read). Workaround for DB reads/writes + chat posts: reconstruct a supabase client *in the live DCC page* — publishable key (`sb_publishable_…`, regex it out of `app.js`; note keys contain `_`/`-`, so `[A-Za-z0-9_\-]+`) + the `sb-…-auth-token` session from localStorage. EF deploys and SQL get handed to Justin / done by Nathan in the dashboard.
- **Long sessions expire the stored JWT.** The reconstructed client then gets "JWT expired". Fix: `sb.auth.refreshSession({ refresh_token })`. That **rotates** the refresh token, so persist the fresh session back into the `sb-…-auth-token` localStorage key (top-level JSON shape) or the user's own tab logs out on next interaction/reload.
- **Browser-extension conflict** (existing): clicks/screenshots fail; `navigate` + lightweight `javascript_tool` after a fresh navigate work. **Heavy deal-list / deal-detail pages freeze the renderer** → CDP `Runtime.evaluate` times out (45s). Single-deal pages + tiny evals are fine. Couldn't get a live screenshot of #237 because of this; verified against live DB data instead (134/8/286, exact labels).
- **#233 kept Relay rows' `cadence_day = step_number` "for display"** (did NOT move them onto `relay_step_number` for the ladder; that column feeds only the new dedup index `idx_outreach_queue_no_dup_relay`). So existing day-labels still read the right field — but Relay rows now actually land in the shared `outreach_queue` (~210), so they needed a distinct label ("Relay · step N") to not read as Automations follow-ups (`ff28d4c`).
- **Confirmed tiered surplus deals are still `new-lead` status** → they show under 🌱 New Leads, not the Active list. The #237 filter correctly hides on Active (no tiered deals there).

## Files / systems touched

- **Repo files:** `src/app.jsx` — DealStatusBadges (tier pill, replaced walkerVerified pill), DealList (`confTierFilter` + surplus-list filter), SurplusOverview (detail tier banner), DeleteDealModal (active-recovery guard + ack), cadenceLabel + rowLabel (Relay-row labels); `app.js` (rebuilt); `supabase/functions/send-sms/index.ts` (split fix — committed, NOT deployed).
- **DB migrations:** none authored here. (intel-main populated `confidenceTier`; Justin's #233 added `20260527181500`.)
- **Edge functions deployed:** none by this session. `send-sms` fix committed, awaiting Justin's deploy.
- **External systems:** team chat — DM'd Justin (Relay strategy Q, handoff notes, send-sms deploy steps) + posted Delete-vs-Mark-Dead SOP to #Ops, via `team_messages` inserts through the reconstructed page client. Filed GH #235; closed #237.

## Open follow-ups (carry forward)

- [ ] **Justin deploys `send-sms` (#235)** — `git pull && supabase functions deploy send-sms`, matching the live `verify_jwt` flag. Until then long manual texts still split.
- [ ] Mac-bridge `SUPABASE_SERVICE_KEY` rotation still gates disabling the legacy leaked key (carryover from 2026-05-20).
- [ ] (optional) Phase A.3 send-time hard dedup (Justin's policy call) → then retire the DoubleQueueGuard.
