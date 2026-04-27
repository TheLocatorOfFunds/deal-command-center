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

**Status**: Idle — last sprint covered JV Partner Portal + Account Settings + Team Chat (4 phases). Several pieces are code-shipped but not yet browser-QA'd; see "Open QA" below.

**Last done (Apr 26–27, 2026)**:

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

**Open QA (code shipped, browser-test pending — Nathan hasn't verified end-to-end)**:
- Drag-drop multi-file upload on Documents tab
- Team Chat Phase 3a (multi-thread switching, Lauren proposal flow)
- Team Chat Phase 3b (reactions render, edit/delete persist, @mention autocomplete suggests + inserts)

**Likely working (Nathan's gut, not formally QA'd)**:
- Account Settings (avatars + online presence + password)
- Comms tab TDZ fix

**Still pending from prior sprints** (untouched this round):
- `.github/workflows/build.yml` exists locally but not pushed — GitHub PAT lacks `workflow` scope. Until it lands, no auto-rebuild safety net: if you forget `npm run build`, `app.js` will be stale on Pages. CLAUDE.md describes this workflow as if it's live; **it is not**. Two ways to land: (a) regenerate the PAT with `workflow` scope, then `git add .github/ && git commit && git push`, or (b) paste the file's contents into GitHub's web UI under Add file → Create new file → `.github/workflows/build.yml`.
- Wire portal SMS toggle to actually send texts on docket events (Justin's lane)
- Lauren no-reply ping spec at `JUSTIN_LAUREN_NO_REPLY_PING_SPEC.md` (Justin's lane)
- DocuSign engagement template wire-up (waiting on Nathan's VA to send Template UUID + Data Labels)
- Email-via-DCC build (spec pending Nathan's "go")

**Last updated**: Apr 27, 2026

<!--
Template:
**Working on**: [feature name]
**Touching**: [files / tables / migrations]
**ETA**: [done today / ongoing]
-->

---

_Clear your entry when you push and merge. If a session crashes mid-work, leave a note
so the other Claude knows the state._
