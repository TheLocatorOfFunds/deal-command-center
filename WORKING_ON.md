# Currently Working On

Two parallel Claude Code sessions share this repo. Update this file at the start and end of
every session so the other side knows what's in flight.

---

## Justin's session

**Status**: Active — Apr 27, 2026
**Working on**: Week sprint — 10-item backlog (double-send test, research routine check, technical notes system, automations brain, calling/recording, email sending, display name fixes, RVM, video-via-text)
**Just finished**: Context preservation system — `.github/PULL_REQUEST_TEMPLATE.md` created, `CLAUDE.md` updated with context preservation section
**Next up**: Automations brain (item #4) + Eric/Inaam display names (#7)
**Touching**: `index.html`, `CLAUDE.md`, `WORKING_ON.md`, `.github/PULL_REQUEST_TEMPLATE.md`
**Last updated**: Apr 27, 2026

---

## Nathan's session

**Status**: Idle as of Apr 27 afternoon — Lauren + team-management work verified end-to-end. Drag-drop upload is the only feature still untested in browser.

**Last done — afternoon of Apr 27, 2026** (in addition to morning ship below):
- `f2148f7` Lauren `@`-mention regex fix — `\b` (backspace) → `\y` (word boundary). Bug had silently broken every `@lauren` mention in team chat since Phase 2 shipped. Verified working: Nathan tested `@lauren` in his DM with Justin after toggling her on, she responded.
- `7fb4de9` profiles.phone column added (Eric was getting "column not found in schema cache" on Save profile) + Lauren on/off toggle in thread header (admin-only).
- `78d24b7` Team modal upgraded — last sign-in column, password vs magic-link badges, "Resend magic link" button per row. Backed by new admin-only RPC `admin_get_team_users()`.
- Housekeeping commit: restored `TRANSFER_TO_NEW_CLAUDE_CODE.md` from archive (Justin referenced it as live in CLAUDE.md), renamed Justin's `20260427000000_messages_outbound_media_url.sql` to `20260427001500_*` to break the timestamp collision with `team_chat_phase1.sql`, clarified the email brand rule in CLAUDE.md (client-facing = RefundLocators; internal founder-to-founder = FundLocators LLC).

**Last done — morning of Apr 27, 2026**:

**JV Partner Portal** (new, token-based share for outside investors on flips — separate from client/attorney portals):
- Deal share with profit %, write-back to deals
- Photo + video upload (any size; HEIC auto-converts to JPEG)
- Tab-based redesign with sticky action bar
- Inline lightbox + gallery strip + filter chips on Documents
- Cover photo settable from lightbox; milestones timeline
- Real Supabase error surfaced on PUT failure
- Photo URL fetching parallelized (70 photos: 21s → fast)
- Fix: `capture=environment` removed so iOS shows the picker menu

**DCC platform**:
- Drag-and-drop multi-file upload on Documents tab (`onDrop` / `onDragOver` at app.jsx:9945–10343)
- Account Settings + avatars + online presence + optional password (`AccountSettingsModal` at app.jsx:12776)
- Comms tab TDZ crash fix: `NATHAN_BRIDGE_NUMBER` hoisted to top of `OutboundMessages` (app.jsx:11386)
- Cache-bust commit so the Comms TDZ fix actually reaches browsers
- JV-Facing Details inputs no longer lose focus on every keystroke
- 👁 Preview buttons + JV portal RPC + `user_deal_views` constraint fix
- Documentation audit landed: 26 stale docs archived to `docs/archive/` (commit `2e99804`)

**Team Chat** (new — internal Nathan ↔ Justin messaging inside DCC):
- Phase 1: basic N+J messaging (`team_threads`, `team_messages`, `team_message_reads`)
- Phase 2: file attachments + Lauren joins as a participant
- Phase 3a: multi-thread + Lauren writes proposals into `lauren_pending_actions`
- Phase 3b: reactions, edit/delete, @mention autocomplete (`team_reactions`)
- Last commit: `a858675` (Apr 27 00:03 EDT) — phase3 migration fix (helper-alias removed, idempotent realtime publication adds)

**Verified end-to-end Apr 27**:
- Lauren `@`-mention in team chat (DM + Ops channel both working after regex fix)
- Lauren on/off toggle in thread header
- Team modal RPC + auth-status badges (loaded data successfully)
- Account Settings save profile (after `phone` column migration applied)

**Open QA (code shipped, browser-test still pending)**:
- ~~Drag-drop multi-file upload on Documents tab~~ ✅ verified Apr 27 PM — single-file drop and 3-file drop both upload to storage + insert documents rows; deal count went 0→1 then 1→4, then cleaned back to 0. Tested on `surplus-moae92eckadd` via synthetic DragEvent + DataTransfer.
- Team Chat Phase 3b — reactions render, edit/delete persist, @mention autocomplete suggests + inserts (autocomplete confirmed via @lauren typing; reactions/edit/delete not formally tested)

**Still pending**:
- `admin@fundlocators.com` (new VA) — Supabase auth rate limit hit; wait ~30 min after last attempt then use the new "📧 Resend link" button in Team modal
- DocuSign engagement template wire-up — UUID `db838549-0777-4f77-86bc-4436d8ec99e5` received from VA; **still waiting on the Data Labels list** (the merge-field names actually used inside the template) before the SQL wire-up can run
- Wire portal SMS toggle to actually send texts on docket events (Justin's lane)
- Lauren no-reply ping spec at `JUSTIN_LAUREN_NO_REPLY_PING_SPEC.md` (Justin's lane)
- Email-via-DCC build (spec pending Nathan's "go")

**Note for Justin**: GitHub Actions auto-rebuild workflow is now live (commit `bf692da`). If you forget `npm run build` before pushing src/app.jsx, the action picks up the slack and commits the rebuilt artifact back with `[skip ci]`.

**Last updated**: Apr 27, 2026 (evening — drag-drop QA pass)

<!--
Template:
**Working on**: [feature name]
**Touching**: [files / tables / migrations]
**ETA**: [done today / ongoing]
-->

---

_Clear your entry when you push and merge. If a session crashes mid-work, leave a note
so the other Claude knows the state._
