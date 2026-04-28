# Currently Working On

Two parallel Claude Code sessions share this repo. Update this file at the start and end of
every session so the other side knows what's in flight.

---

## Justin's session

**Status**: Diagnosed two bugs in iMessage bridge. NOT pushing code from this session.
**Last updated**: Apr 28, 2026

**Bug A — Bridge silently fails for non-iMessage recipients:**
- `mac-bridge/bridge.js` AppleScript forces `service type = iMessage` (lines ~171 and ~217 in current Mac copy). When recipient isn't on iMessage, the send fails with error 22 in chat.db (`is_sent=0`, `is_delivered=0`).
- Bridge marks `status='sent'` immediately after `osascript` exit 0 (line ~267) — so failures look like successes in DCC.
- Verified on defender-mini: 5 silent failures in last 4 days (Richard Mikol +12165770123 today × 2, +16149374957 on Apr 24 × 2 + Apr 27 × 1). 52/52 outbound from this Mac = iMessage; SMS service never used; SMS forwarding iPhone → Mac is not enabled.
- Fix needs: (1) post-send chat.db verification (poll for matching outbound row, set status to `sent` only if `error=0 AND is_sent=1`, else `failed`); (2) drop forced iMessage service; (3) Nathan enables Text Message Forwarding to Defender Mini on iPhone; (4) optional pre-flight check against chat.db history.
- Did NOT push fix because Mac is at e6ac7bce, 5 bridge commits ahead of my branch (thread_key, group-chat, MMS, PID lock, single-instance). Fix belongs in your session.

**Bug B — Personal iMessage group chats leak into deals (full report given to Justin verbally for paste into your session). Your in-progress group-chat work should kill it as a byproduct if it routes by chat-id rather than phone match.**

**Touching**: only WORKING_ON.md (read-only diagnosis everywhere else)
**ETA**: handed off

<!--
Template:
**Working on**: [feature name]
**Touching**: [files / tables / migrations]
**ETA**: [done today / ongoing]
-->

---

## Nathan's session

**Status**: Idle
**Last done**: Deal Hygiene dashboard — new 🩺 Hygiene view on the main nav. Scans all open surplus deals against 13 checks (phone, email, portal access, court case, county, filed date, deadline, est. surplus, fee%, attorney, counsel portal, docs uploaded, welcome video) and shows per-deal completeness with top-gap filter chips + expand/collapse detail rows. Click-through to open the deal to fix. Discovered: 16/17 missing phone, 15/17 missing client portal access, 17/17 missing deadline — huge activation opportunity in filling these in.
**Last updated**: Apr 22, 2026

<!--
Template:
**Working on**: [feature name]
**Touching**: [files / tables / migrations]
**ETA**: [done today / ongoing]
-->

---

_Clear your entry when you push and merge. If a session crashes mid-work, leave a note
so the other Claude knows the state._
