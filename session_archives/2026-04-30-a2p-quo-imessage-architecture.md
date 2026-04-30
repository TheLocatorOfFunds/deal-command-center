# Session 2026-04-30 — A2P 10DLC + Quo + iMessage architecture

**Owner:** Justin
**Branch(es):** `docs/a2p-corrected-audit`, `docs/a2p-port-is-twilio-transfer` (rejected by GitHub secret scanning), `chore/pin-verify-jwt-lauren`, `chore/lauren-rpc-overload-fix`, `chore/lauren-followup-files`, `chore/remove-lauren-rooms`, `docs/mac-bridge-recovery`, `deploy-twilio-ui-fix`
**Related PRs:** #20 Twilio UI hide, #21 Chat crash + Mac bridge runbook, #23 Lauren rooms removal, #24 fixup migration, #25 RPC overload fix, #26 verify_jwt pin, #27 A2P registration package, #28 A2P audit correction

## What we set out to do

Justin asked to fix Mac bridge texting (Nathan's iPhone wasn't sending),
remove the Twilio number from DCC UI, then walked the Twilio A2P 10DLC
registration path end-to-end. Surfaced multiple architectural mismatches
along the way and pivoted decisions as new information landed.

## Decisions made (durable — these change behavior going forward)

### SMS architecture
- **Mac bridge stays primary SMS for the foreseeable future.** It's the
  only path that gets blue-bubble iMessage to iPhone recipients +
  no-opt-out language to Android recipients (P2P-flavored from a real
  consumer cell line). This matches the SendBlue / WhatSnap business
  model — Justin already runs that architecture, just at scale=1.
- **Twilio A2P 10DLC track parked, not pursued.** Brand registration
  was filed (~$4.50, in TCR review). Campaign filing skipped. The
  registration sits as a future backup if/when SMS volume requires
  proper A2P infrastructure.
- **Quo (formerly OpenPhone) is voice-only.** Declined Quo's email
  upsell to enable SMS. Quo's API routes through standard A2P SMS
  infrastructure — would lose the no-opt-out advantage we want.
- **GHL/HighLevel transfer of `+1 513-951-8855` is dropped.** Twilio
  port-in attempt revealed the number is "Already in Twilio different
  owner" — a Twilio-to-Twilio sub-account transfer, not a carrier port.
  Without a clear use case for the number on Twilio (since SMS isn't
  going there), no point chasing the transfer.

### Lauren architecture
- **`lauren_room` thread spawning removed.** Lauren no longer creates
  shared rooms when "loop X in" / "tell X" intents fire. Both intents
  now route through `propose_relay_to_teammate` which posts a
  Lauren-authored message into the existing Justin↔Nathan DM in the
  Chat tab. Justin's principle: Lauren is an agent, not a chat host;
  the team Chat is where humans talk to each other.

### Operational hygiene
- **`verify_jwt = false` pinned in `supabase/config.toml`** for
  `lauren-team-respond`. The function is invoked by a pg_net trigger
  with no auth header — every redeploy without `--no-verify-jwt` was
  breaking Lauren silently. Pinning in config makes it survive any
  deploy.
- **Mac Mini FileVault stays ON.** Decided 2026-04-28 — Justin chose
  encryption-at-rest over uptime; manual VNC recovery after outages
  is the accepted cost. (Full context: `memory/mac_mini_filevault.md`)

## Gotchas hit (non-obvious; future sessions need to know)

### `fundlocators.com` lead form lives in an iframe
Initial site audit reported "no forms on fundlocators.com" — this was
**wrong**. The lead form (with proper SMS consent checkbox) is rendered
from a GHL widget at `link.magnetixagency.com/widget/form/<id>`,
embedded as an iframe on the home page and on `/get-your-money-today`.

`document.querySelectorAll('form, input')` from the parent document
returns zero forms because cross-origin iframes don't expose their
contents to parent JS. Static-fetch HTML similarly returns the shell
without the iframe payload.

**Audit lesson:** when checking opt-in UX on any third-party-built
marketing site, always render in a real browser and visually inspect
iframes. Don't trust DOM queries from the parent document.

### Twilio `--no-verify-jwt` flag isn't sticky
Each `supabase functions deploy lauren-team-respond` requires
`--no-verify-jwt` explicitly or it re-enables JWT verification. The
pg_net trigger calling the function has no auth header → returns 401
silently → Lauren stops responding to team-chat messages. Multiple
sessions deploying for unrelated work kept dropping the flag.

**Fix:** pinned in `supabase/config.toml` via PR #26. Future deploys
respect the setting regardless of who runs the deploy command.

### TeamView crash on every Chat-panel click
`src/app.jsx:1243` had `sb.rpc('lauren_get_or_create_dm').catch(err => …)`
in a `useEffect`. Supabase v2's `.rpc()` returns a thenable
`PostgrestFilterBuilder`, not a real `Promise` — `.catch()` is
`undefined` and throws synchronously inside the effect, unmounting all
of TeamView. Symptom: clicking 💬 Chat blanked the page; no error
visible to the user.

**Fix:** PR #21 — replace `.catch(err => …)` with
`.then(({ error }) => …)`. This is a recurring footgun; treat any
`sb.rpc().catch(...)` pattern as a bug.

### `lauren_execute_action` overload ambiguity
PR #23's fixup migration did `CREATE OR REPLACE FUNCTION
lauren_execute_action(p_action_id uuid)` (1-arg) but the canonical
prod version was the 2-arg variant
(`p_action_id uuid, p_caller_id uuid DEFAULT NULL`). Postgres treated
this as a NEW overload, leaving both. Single-arg client calls then
matched both → "Could not choose the best candidate function."
Confirm button on Lauren proposals errored.

**Fix:** PR #25 — `DROP FUNCTION` the 1-arg version, then
`CREATE OR REPLACE` the canonical 2-arg version with the
`loop_in_teammate` branch redirected to DM (since
`lauren_create_room_with` got dropped earlier).

### Twilio "Port-in eligibility check" on `+1 513-951-8855`
Result: "Already in Twilio different owner." That number isn't on
Bandwidth or another carrier — it's already inside Twilio, in
some other Twilio account. Most likely HighLevel's master account
(GHL is one of Twilio's largest ISVs). Confirming the actual owning
account requires a Twilio support ticket. Either way, this is a
Twilio inter-account transfer, **not a carrier port**:
- Losing party files a Twilio support ticket from their account
- ~1-3 days vs. 7-10 days for a real port
- Typically $0 fees vs. carrier port-out fees

If we ever revisit moving this number, that's the path. For now, it's
not being pursued.

### GitHub Push Protection blocks Twilio Account SIDs
A draft of the A2P doc included Justin's full Twilio Account SID
(`ACa521…`) in the example LOA email text. GitHub's secret scanning
correctly classifies these as secrets and rejects pushes. Don't
commit Twilio SIDs (or any provider account identifiers) to docs even
in private repos. Use placeholder text + a pointer to where the user
can read it from their console.

### SendBlue / WhatSnap aren't doing magic — they're phone farms
Both services run racks of real Apple devices with real Apple IDs
and real consumer cell plans, exposed via REST API. Outbound goes:
Apple hardware → Apple iMessage servers → recipient. iPhone recipients
get blue-bubble iMessage. Android recipients get the iMessage→RCS→SMS
fallback chain — RCS bypasses A2P filtering, SMS at conversational
volume from a personal cell line is treated as P2P. **No service
provider can give you "no opt-out language to Android via API"
without using real Apple hardware.** Cloud SMS APIs (Twilio, Quo,
Bandwidth, Plivo) all route through carrier A2P infrastructure and
require the registration + opt-out language regime.

The Mac bridge IS the SendBlue model, just at scale=1. Scaling up
means adding more iPhones with consumer cell lines, not switching to
a different SMS API.

## Files / systems touched

### Repo files (committed via PRs above)
- `src/app.jsx` — Twilio number hide from dropdowns (PR #20), TeamView
  crash fix (PR #21), Lauren rooms confirmAction cleanup (PR #23)
- `app.js` — rebuilt artifacts for the above
- `supabase/config.toml` — `[functions.lauren-team-respond] verify_jwt = false` (PR #26)
- `supabase/migrations/20260428040000_remove_lauren_rooms.sql` (PR #23)
- `supabase/migrations/20260428040001_remove_lauren_rooms_fixup.sql` (PR #24)
- `supabase/migrations/20260428040002_lauren_execute_action_resolve_overload.sql` (PR #25)
- `supabase/functions/lauren-team-respond/index.ts` — removed
  `propose_loop_in_teammate` tool + handler, rewrote LOOP-IN
  DISCIPLINE prompt section (PR #23)
- `docs/MAC_BRIDGE_RECOVERY.md` (PR #21) — runbook for VNC/SSH recovery
  after a power outage strands the Mac at the FileVault unlock screen
- `docs/A2P_10DLC_REGISTRATION.md` (PRs #27, #28) — full A2P submission
  package, audit results, TCPA caveat, Twilio inter-account transfer
  notes

### Migrations applied to prod (live)
- `20260428040000_remove_lauren_rooms.sql` — partial-applied; constraint
  tightening rejected by historical rows
- `20260428040001_remove_lauren_rooms_fixup.sql` — completed the work
- `20260428040002_lauren_execute_action_resolve_overload.sql` — fixed
  overload ambiguity

### Edge functions deployed
- `lauren-team-respond` — multiple redeploys today (with
  `--no-verify-jwt`); final version from `origin/main` after PR #26
  pinned the config

### External systems
- **Twilio Console** — account upgraded out of trial, ~$50 deposit;
  Brand registration submitted to TCR (~$4.50 in review); Port-in
  wizard run + abandoned at eligibility check
- **Magnetix Agency CMS (web.magnetixagency.com / GHL whitelabel)** —
  privacy policy phone number patched (`951-3014` → `951-8855` in
  two locations); GHL Forms editor on the lead form's consent
  checkbox label patched
- **fundlocators.com (live site)** — verified both patches reached
  the live site

## Open follow-ups (carries forward to a future session)

- [ ] **Twilio Brand approval** — TCR usually 1-3 days; Brand will
  approve into the parked state. Do nothing unless we revisit the
  A2P track.
- [ ] **Quo SMS A2P registration email** — decline politely or just
  ignore. We're voice-only on Quo.
- [ ] **Mac bridge scaling** — currently ~150-200 messages/day cap on
  Nathan's single iPhone. When/if volume requires more, add a second
  iPhone with a Boost Mobile or similar consumer prepaid SIM and
  extend the bridge daemon to drive both. Model: SendBlue at scale=2.
- [ ] **Erik onboarding** — VA support hire, has Claude Code premium
  seat. Setup playbook drafted in conversation but not yet executed.
- [ ] **Live session state convention rolling out** — this very PR.
  Watch for adoption; iterate if Nathan/Erik/Justin sessions don't
  consistently update WORKING_ON.md.
