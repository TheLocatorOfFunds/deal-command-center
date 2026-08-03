# Build brief: Caller Cockpit (first-touch outreach queue + call logging)

**For:** Nathan's DCC Claude agent
**Author:** Director (intel-main session), 2026-05-21
**Status:** ready to build · v1 scoped below
**Repo:** this one (deal-command-center) · edit `src/app.jsx`, `npm run build`, commit `app.js`

---

## Why this exists

Nathan is hiring a first-touch outreach caller. Her job is NOT to close — it's to
**qualify and warm-hand-off**: confirm we have the right number + right person,
express empathy, explain who we are at a high level, and book the real
conversation with Nathan or a manager.

Her bottleneck-killer is a **cockpit**: a clean, prioritized call queue where every
lead is confirmed-real, and a dead-simple way to log what happened on each call.
Hand her a 4,000-row spreadsheet and she drowns. Hand her this and she just dials.

This is **100% DCC-side** — she works in one tool (app.refundlocators.com), not
intel-main. intel-main's only job is to keep feeding confirmed-ready leads into
the `new-lead` column (already happening) and to receive call outcomes back later
(v2, see bottom).

---

## What intel-main guarantees is already on every surplus deal

Don't re-fetch or recompute these — they're written to `deals.meta` by intel-main's
push + sync crons and kept fresh. The caller's queue should just read them:

| field | meaning |
|---|---|
| `meta.estimatedSurplus` / `verifiedSurplus` | the money at stake |
| `meta.county`, `meta.courtCase` | jurisdiction + case # |
| `meta.salePrice`, `meta.saleDate`, `meta.judgmentAmount`, `meta.totalDebt` | the financial picture |
| `meta.case_intel_summary` | plain-English "what happened here" (the caller's talking context) |
| `meta.grade` | A/B/C — only confirmed-real leads reach `new-lead` |
| `meta.intel_main_url` | deep link back to the full case |
| `deal.name`, `deal.address` | homeowner + property |
| linked `contacts` via `contact_deals` | homeowner + family, each with phone(s) |
| `contacts.do_not_call` / `do_not_text` | **compliance — must respect, see below** |

So the queue has everything it needs already. No new intel-main work for v1.

---

## v1 — what to build

### 1. "Call Queue" view (new top-level nav item, or a tab under Outreach)

A focused, work-top-down list of leads ready for first-touch. Filter:
- `deal.type = 'surplus'`
- `deal.status = 'new-lead'` (or a new `call_stage` = `uncalled`)
- has at least one linked contact with a phone AND `do_not_call = false`
- order: highest `verifiedSurplus`/`estimatedSurplus` first (best leads on top)

Each queue item shows on ONE screen (no hunting):
- Homeowner name + property address
- Surplus $ (big, green)
- County · case #
- The **primary phone** to dial (homeowner's bare-token contact — see
  `personalized_links` / `contact_deals` homeowner row)
- A 1-2 line "what happened" pulled from `meta.case_intel_summary`
- A **"Start call"** button → opens the call panel (#2)

Keep it minimal — she should be able to glance, dial, log, next.

### 2. Call panel + disposition logging

When she clicks "Start call," show the contact's number(s) + the talking context,
and a row of **one-tap outcome buttons**. After the call she taps one:

| Outcome | What it should do |
|---|---|
| ✅ Reached — right person | advance `call_stage` → `reached`; prompt for interest |
| 📞 Reached — interested → handoff | mark `qualified`; create a follow-up task assigned to Nathan/manager + book callback time |
| 🚫 Not interested | `call_stage` → `declined`; log reason note |
| 🔁 Wants callback | `call_stage` → `callback`; capture date/time → shows back in queue then |
| ☎️ No answer / voicemail | increment attempt count; requeue with a cooldown (e.g. back in 2 days) |
| ❌ Wrong number | flag the contact's phone bad; try next contact phone if any, else `call_stage` → `bad_number` |
| ⚰️ Deceased | flag deceased; route to the family/heirs contacts on the deal |
| ⛔ Do not call | set `contacts.do_not_call = true`; remove from queue permanently |

Plus an optional free-text note. Every tap writes an `activity` row (audit) and,
ideally, a `call_attempts` row (see data model).

### 3. Data model (minimal additions)

```sql
-- New table: one row per call attempt (the outcome log)
create table if not exists call_attempts (
  id           uuid primary key default gen_random_uuid(),
  deal_id      text references deals(id) on delete cascade,
  contact_id   uuid references contacts(id),
  phone        text,
  outcome      text not null,         -- reached / interested / not_interested / callback / no_answer / voicemail / wrong_number / deceased / do_not_call
  notes        text,
  callback_at  timestamptz,           -- when outcome = callback
  called_by    uuid references profiles(id),
  called_at    timestamptz default now()
);
-- RLS: admin + va (callers are likely va-role). Use the existing is_admin()/is_va() helpers.

-- Lightweight stage on the deal so the queue can filter without scanning calls
alter table deals add column if not exists call_stage text;  -- uncalled / reached / qualified / callback / declined / bad_number
```

Don't reuse `messages_outbound` for calls — that's the SMS/iMessage table. Calls
are their own thing.

### 4. Compliance (non-negotiable)

- **Respect `contacts.do_not_call`** — never show a DND contact in the queue.
- The "Do not call" outcome must set `do_not_call = true` immediately.
- These are distressed homeowners post-foreclosure. The tone is empathy-first
  (Nathan's framing: "How are you doing? We're sorry this happened."). The cockpit
  should make the *context* visible so she's never cold — but the script/copy
  itself is Nathan's to write, not this spec's.

---

## The call flow this supports (Nathan's words, structurally)

1. Confirm right number + right person  → `Reached — right person`
2. Empathy + who-we-are (high level)
3. Gauge interest → "would you like a conversation with Nathan / my manager?"
4. If yes → `interested → handoff` (book the callback, assign the task)
5. If no / not now → `not interested` or `callback`

The cockpit's job is to make 1–5 one screen + one tap each. The persuasion copy is
Nathan's; the *workflow rails* are this build.

---

## v2 — outcome writeback to intel-main (feedback loop, later)

Once v1 is logging outcomes, the high-value follow-up: send terminal outcomes back
to intel-main so the grading engine learns which leads actually convert.

**Contract (Director will build the receiver):**
- On a terminal outcome (`deceased`, `wrong_number`/`bad_number`, `qualified`,
  `declined`, and eventually `recovered`/`dead` at the deal level), DCC posts to
  intel-main's `intel_event` (or a `/api/dcc-callback` endpoint) with:
  `{ intel_case_id (from meta.intel_case_id), outcome, contact_reachable, called_at }`
- Director consumes it to retune the grade (e.g. deceased confirmation → B;
  repeated bad-number → down-rank; qualified → up-rank).
- This is the parked "Phase 2B" loop. **Don't build it in v1** — just make sure
  `call_attempts.outcome` is clean enough to replay later.

---

## Acceptance criteria (browser-test per DCC QA protocol)

1. Call Queue shows only `new-lead` surplus deals with a callable, non-DND contact, surplus-sorted
2. Each item shows name / address / surplus / phone / "what happened" with no extra clicks
3. "Start call" → panel with number + context + outcome buttons
4. Each outcome writes `call_attempts` + `activity`, updates `call_stage`, and the item leaves/returns to the queue correctly (e.g. callback reappears at its time; do-not-call disappears for good)
5. DND contacts never appear
6. No console errors after each interaction (`read_console_messages` onlyErrors)

---

## Notes for the DCC agent

- DCC likely already has pieces to reuse: the Outreach view, the comms tab,
  `activity` logging, the kanban status machinery, `contacts.do_not_call`. Prefer
  extending what's there over net-new where it fits.
- Caller role is probably `va` in `profiles.role` — gate the queue + logging to
  `is_admin() OR is_va()`.
- Outbound SMS (if she ever texts) goes via mac_bridge / Nathan's iPhone, NOT
  Twilio — but v1 is voice-only, so likely no SMS needed.
- File this as a GitHub issue per the repo's backlog convention if it won't ship
  in one session.
