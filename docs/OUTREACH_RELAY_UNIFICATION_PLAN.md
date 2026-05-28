# Outreach + Relay — UI Unification Plan

_Architected after the 5/27 backend convergence (PR #233 et al.). Drafted for Justin to review before any code._

The **backend merge is done** — both engines feed one shared `outreach_queue` (Relay rows labeled "Relay · step N"), double-text guard in place, AutomationsQueue is the single queue surface (de-duped per `0f4508d`). What remains is the **UI**: two separate top-level tabs (🎯 Outreach + 📡 Relay) for what is now one workflow.

This plan unifies the UI without losing either capability.

---

## Today's state (grounded in code, not memory)

### `OutreachView` (`src/app.jsx` ~line 8930)
- Renders for `view === 'outreach'`.
- 4 stat tiles: `pending_drafts`, `replies_waiting`, `scheduled_24h`, `sent_today`.
- Below: `AutomationsQueue` (the shared queue surface, ~line 12772).
- Data: `outreach_queue` + `messages_outbound`. Realtime on both.
- This is the **daily-work surface**: review drafts, see replies, see what's about to send.

### `RelayView` (`src/app.jsx` ~line 8223)
- Renders for `view === 'relay'`.
- State: `enrollments`, `sequences`, `pendingTouches`, `rvmTouches`, plus per-touch `coachByTouch` / `regenByTouch`.
- Data: `relay_enrollments`, `relay_sequences`, `outreach_queue` filtered to `relay_enrollment_id IS NOT NULL`, `relay_scheduled_touches`.
- Features: enrollment list, sequence management, scan-and-enroll, **RVM approval queue**, **per-touch coach notes + Claude regen** (training-data capture).
- This is the **engine-management surface**: who's enrolled in what cadence, RVM approvals, coach the AI.

### What's already shared / good
- One `outreach_queue` table for both engines.
- `AutomationsQueue` is the one rendering of the queue (de-duped, double-text-guarded).
- Relay rows labeled distinctly in the queue (`ff28d4c`).

### What's confused / split
- Two top-level nav tabs for one workflow.
- Stats tiles only on Outreach. Enrollment + RVM + Coach features only on Relay.
- Coach UX is **per-touch inside Relay only** — open issue **#189** asks to lift coach feedback to the queue level.
- "Where do I work from?" is unclear (Justin asked it during the 5/27 comms session).

---

## Proposed architecture

**One top-level tab:** **🎯 Outreach** (keeps the user-facing word; "Relay" is the engine name internally).

**Top-level nav after unification:**
- Today, Deadlines, **🎯 Outreach**, ~~📡 Relay~~ (retired, redirects to Outreach), 💬 Comms, …

Inside Outreach, **two sub-tabs** (mirrors the pattern from the Communications tab we shipped today):

### Sub-tab 1 — **Queue** _(default)_
The daily-work surface. Where 90% of time goes.

- **Stats tiles row** at top: keep the 4 existing (`pending_drafts`, `replies_waiting`, `scheduled_24h`, `sent_today`) + add 2 Relay-specific (`active_enrollments`, `rvm_awaiting_approval`). 6 tiles total.
- **`AutomationsQueue`** as the primary panel — already shows both engines' rows with distinct labels.
- **Engine filter chips** at the top of the queue: `All / Outreach / Relay` (lets you focus when you want, but defaults to All).
- **Coach + regen inline on every row** — lift the per-touch coach UI from `RelayView` so every queue row (not just Relay ones) has a coach note field + Regenerate button. This closes **issue #189**.
- Click a row → drills into the deal's Comms tab (closes **#190**).

### Sub-tab 2 — **Enrollments**
The engine-management surface. Less frequent visits; deep work.

- **Scan-and-enroll** CTA + scan results (existing from RelayView).
- **Active enrollments table**: who's enrolled, in what sequence, current step, next touch time. Click → deal.
- **RVM approvals** panel (the one-tap Approve & Drop UI from RelayView).
- **Sequences reference** — read-only list of sequences so you can see what cadence each enrollment runs.

### Why not a third "Coach" sub-tab?
Considered it. Decided no — coach feedback is **per-row work** (review a draft, leave a note, regenerate). Lifting it inline on the Queue means you give feedback while doing the daily work. A separate Coach page would split attention and make the feedback loop feel like a chore.

---

## Information hierarchy (single page, Queue sub-tab)

```
┌──────────────────────────────────────────────────────────────┐
│ 🎯 Outreach                                                   │
│ ┌─Queue ─┐  Enrollments                                       │
│ └────────┘                                                    │
│                                                               │
│ ┌──── Stats (6 tiles) ───────────────────────────────────┐   │
│ │ Pending  Replies  Scheduled  Sent       Active    RVM   │   │
│ │ drafts   waiting  next 24h   today      enrolls   pending│   │
│ └────────────────────────────────────────────────────────┘   │
│                                                               │
│ [All]  [Outreach]  [Relay]                                    │
│                                                               │
│ ┌─ AutomationsQueue ───────────────────────────────────────┐ │
│ │ Smith case · Intro draft · 2h ago                          │ │
│ │   "Hey, it's Nathan with RefundLocators…"                  │ │
│ │   [Send] [Edit] [Skip]   coach: [_____________]  [Regen]   │ │
│ │                                                             │ │
│ │ Novak case · Relay · step 3 · scheduled 4h                  │ │
│ │   "Just checking in on the…"                                │ │
│ │   [Send now] [Edit] [Skip]   coach: [______________] [Regen]│ │
│ │ …                                                           │ │
│ └────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

---

## Migration / preservation

- **Don't break URLs:** keep `#/relay` as an alias that loads `view='outreach'` with sub-tab pre-selected to **Enrollments**.
- **Don't break realtime:** queue stays on the same `outreach_queue` channel.
- **Don't lose coach data:** existing `outreach_queue.coach_note` column already exists (per `RelayView` notes). The Queue-row coach input writes to that same column for every row — no migration.
- **Sub-tab persistence:** remember the last-used sub-tab in localStorage so a refresh doesn't bounce you back to Queue (closes **#188**, generalized).

---

## Phased build plan

### Phase 1 — Shell (Small, ~2-3 hr)
- Add sub-tab state to `OutreachView` (default `queue`, persist in localStorage).
- Move existing OutreachView body into a `<OutreachQueueTab>` sub-component (the stats tiles + AutomationsQueue + filter chips).
- Move existing RelayView body into a `<OutreachEnrollmentsTab>` sub-component (enrollments + RVM + scan).
- Render the sub-tab strip + switch.
- Retire `📡 Relay` top-level nav item; add `#/relay` alias that opens Outreach with Enrollments tab.
- **Cost:** mostly a refactor; no new functionality. Low risk.

### Phase 2 — Lift coach to queue rows (Medium, closes #189)
- Pull the per-touch `coachByTouch` / `regenByTouch` state + UI out of the Enrollments tab and into `AutomationsQueue` row rendering (so every row has coach + regen, not just Relay ones).
- Wire to the existing `generate-outreach` Edge Function (Relay's regen) for ALL rows uniformly.
- **Cost:** moderate — the regen flow exists, just needs to be generalized.

### Phase 3 — Polish (Small)
- 2 new stats tiles (`active_enrollments`, `rvm_awaiting_approval`).
- Engine filter chips (`All / Outreach / Relay`) on the queue.
- Click-deal → default to Comms tab (closes **#190**).
- Update issue **#225** title — currently says "Relay retired"; reframe as "Outreach + Relay unified into one tab with two sub-tabs."

---

## Decisions — locked (5/27 Justin)

1. **Tab name:** ✅ **`🎯 Automations`**
2. **Sub-tab names:** ✅ **"Ready to Approve"** + **"Enrolled"**
3. **Coach UX:** ✅ inline on every queue row (no separate sub-tab)
4. **`#/relay` alias:** ✅ keep as alias → opens Automations with Enrolled pre-selected
5. **Stats tiles:** ✅ all 6 (4 existing + 2 Relay-specific)

---

## Open issues this closes

| # | Closes via |
|---|---|
| **#188** persist active tab/view across refresh | Sub-tab persistence in localStorage |
| **#189** Relay coach/feedback at queue level (not deal detail) | Phase 2 — coach lifted to queue rows |
| **#190** Clicking into deal from Relay defaults to Comms tab | Phase 3 polish item |
| **#225** Outreach consolidated to Automations; Relay retired | Plan delivers the actual unification; title updated |

---

## What I would NOT touch in this plan

- The shared `outreach_queue` table + double-text guard + Relay-row labeling — already shipped, working.
- The `generate-outreach` Edge Function — used by both engines today; stays untouched.
- The cadence engines themselves (whatever queues the Outreach drafts vs the Relay touches) — they continue to run; we're only re-organizing the UI on top.
