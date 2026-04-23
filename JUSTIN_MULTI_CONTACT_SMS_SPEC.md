# Multi-Contact Conversation View — Spec for Justin

**From:** Nathan's DCC Claude session, 2026-04-22
**For:** Justin's Claude session (SMS / iMessage lane)
**Status:** spec, not yet built
**Owner:** Justin (per [CLAUDE.md](CLAUDE.md) domain table)

---

## 0. Read this first

Nathan wants to evolve our outbound SMS from a single-thread-per-deal model (one homeowner, one phone, one linear message list) into a **multi-contact conversation view**. A single surplus-recovery case often involves conversations with the homeowner, their spouse, adult children, siblings, neighbors who have info, the attorney, and sometimes a probate administrator. Today we can only cleanly message the homeowner. Everything else is either a Nathan-goes-to-his-iPhone problem or a cryptic inbound SMS from an unknown number.

The goal is to make DCC the single surface where every conversation on a case is visible, grouped by who you're talking to, across SMS + iMessage + group text.

Nathan is non-technical. Keep implementation details inside this repo + WORKING_ON.md; summarize progress to him in business-first language.

---

## 1. Current state (what exists, what's missing)

### What works today ✅
- `messages_outbound` table stores SMS with `deal_id`, `direction` (outbound/inbound), `to_number`, `from_number`, `body`, `status`, `created_at`.
- `send-sms` Edge Function (Justin) — 16 outbound sent, 14 inbound received, 3 failed. Twilio-backed.
- `receive-sms` Edge Function (Justin) — inbound SMS writes to `messages_outbound` with `direction='inbound'`.
- `phone_numbers` table — 2 active Twilio numbers.
- `OutboundMessages` React component in `index.html` — per-deal SMS thread UI. Uses `sb.functions.invoke('send-sms', ...)`.
- Unified Timeline on the deal detail (`Activity` component) renders `messages_outbound` as 📲 Inbound SMS / 📤 Outbound SMS entries, mixed with other events.
- `Send Intro Text` modal — tier-based templated first-touch SMS to `meta.homeownerPhone`. Flips `sales_stage` to `texted` on success.
- `sms_templates` table with 4 active templates (A/B/C/30DTS tiers).

### What's broken or missing ❌
- **No contact identity on inbound SMS.** When `receive-sms` gets a text from +15135551234, we store the phone number but have no idea if that's the homeowner, their cousin, a neighbor, or a wrong number. The UI has to guess.
- **No grouping by conversation partner.** The `OutboundMessages` component shows one flat list per deal. Two simultaneous conversations (homeowner on his cell + spouse on hers) interleave chronologically and it's hard to read.
- **No group texting.** Can't send one message to N recipients and track the replies.
- **No iMessage.** Mac Mini bridge is TBD.
- **No contact-to-phone linkage used in routing.** `contacts` has a `phone` field; `contact_deals` links contacts to deals. But `messages_outbound` doesn't reference `contacts.id`, so we can't say "this message came from the homeowner's daughter (contact X on this deal)."
- **Unknown number surprise.** When an inbound SMS lands from a number not on `meta.homeownerPhone` or `contacts.phone`, the message still attaches to *some* deal via `messages_outbound.deal_id`, but nothing flags it for Nathan to say "who is this?"

---

## 2. What Nathan wants (the business view)

When he opens a deal, he should see:

```
Case: Casey Jennings · Franklin County · A2301234

Conversations (4 active)
┌────────────────────────────────────────────────┐
│ 🏠 Casey Jennings · Homeowner · +15135551234    │ ← last msg 2h ago
│ "Thanks Nathan, I'll sign today..."             │
├────────────────────────────────────────────────┤
│ 👨‍👩‍👧 Maria Jennings · Daughter · +15135559876    │ ← last msg 1d ago
│ "My dad is in the hospital, can you..."         │
├────────────────────────────────────────────────┤
│ 🏘 John (neighbor) · Neighbor · +15135552222    │ ← last msg 5d ago
│ "Casey isn't staying at the house anymore..."   │
├────────────────────────────────────────────────┤
│ 👥 Group: Casey + Maria + Nathan · iMessage     │ ← last msg 3h ago
│ "Let me loop my daughter in..."                 │
└────────────────────────────────────────────────┘
```

Click any row → full thread UI for that conversation partner, with the ability to send (SMS to Twilio number, or iMessage to Apple ID), attach files, see read receipts if iMessage, etc.

**New inbound from unknown number** → top of the deal detail shows:
```
⚠ Unknown contact texted this case
"+15135557777 — Is Casey still staying with you? Tell him his sister called"
[+ Save as contact on this deal] [Ignore / spam]
```
Clicking save opens a mini-form: name + relationship (homeowner / spouse / child / sibling / neighbor / attorney / other). Saves to `contacts` + auto-links via `contact_deals`. Future messages from that number slot into that contact's thread.

---

## 3. Data model changes (Justin's to design)

Minimum: `messages_outbound` needs a `contact_id` foreign key to `contacts.id` (nullable — we don't always know).

Draft shape:

```sql
alter table public.messages_outbound
  add column if not exists contact_id uuid references public.contacts(id) on delete set null,
  add column if not exists thread_key text;  -- stable key grouping messages in one conversation

-- thread_key examples:
--   '<deal_id>:contact:<contact_id>'          for single-contact threads
--   '<deal_id>:group:<hash-of-participants>'  for group messages
--   '<deal_id>:phone:<normalized-phone>'      fallback when no contact yet

create index if not exists idx_messages_outbound_thread
  on public.messages_outbound(deal_id, thread_key, created_at desc);
```

Routing rule for inbound SMS (update `receive-sms`):
1. Look up the sender's phone in `contacts` where contact is linked to a deal via `contact_deals`.
2. If match: set `contact_id` + `thread_key = '<deal_id>:contact:<contact_id>'`, route to that deal.
3. If no contact but phone matches `deals.meta->>'homeownerPhone'`: route to that deal as "homeowner" (legacy behavior). Create a contact stub `kind='homeowner'` auto-linked to the deal so future messages find the match.
4. If no match anywhere: land in a new `messages_outbound_unmatched` queue (mirror of `docket_events_unmatched`) for Nathan to triage.

Group texts:
- New table `message_groups` with `id uuid`, `deal_id text`, `label text`, `participants jsonb` (array of `{contact_id, phone, name}`), `channel text check (channel in ('sms','imessage'))`.
- `messages_outbound.group_id uuid references message_groups(id)` (nullable).
- `thread_key` for group messages = `'<deal_id>:group:<group_id>'`.

---

## 4. DCC UI changes (Justin's to build, or hand to Nathan's session)

### A. Replace `OutboundMessages` with `DealConversations`
New component. Takes `dealId`. Fetches all `messages_outbound` for the deal, groups by `thread_key`, renders conversation list in the shape above. Clicking a row renders the single-thread view (existing `OutboundMessages` chat UI is mostly reusable for this — just filter by `thread_key`).

### B. New "contact this case" affordance
On the conversation list, an `+ Add conversation` button. Opens a mini-form: pick an existing `contact` linked to this deal, OR create a new contact inline (name + phone + relationship). On save, the contact gets linked via `contact_deals` and a new empty thread opens.

### C. Unknown-contact triage banner
Deal detail shows a warning strip at the top if any `messages_outbound` on this deal has `contact_id IS NULL` AND sender phone doesn't match `meta.homeownerPhone`. Clicking the strip opens a compact triage UI to save-or-ignore the phone.

### D. Unified Timeline (the long scrolling feed) — already renders SMS
No change needed structurally, but each SMS line should now display the contact name + relationship (not just the phone number). Look at the `extra.sms.map(...)` section of `Activity` around line 6504 in `index.html`.

### E. Cross-deal unknown-SMS inbox
Admin-only view (add to DCC nav): "📥 Unmatched SMS" — shows rows from `messages_outbound_unmatched` across all deals. One-click match to a deal + contact.

---

## 5. iMessage bridge (new, Justin's Mac Mini daemon)

The write-up in [CLAUDE.md](CLAUDE.md) says this is TBD. Here's what this feature needs from it:

- **Send:** a Deno-compatible HTTP endpoint that DCC can POST `{ to: phone_or_apple_id, body, deal_id, contact_id?, group_id? }` to. Daemon triggers an AppleScript to send via Messages.app.
- **Receive:** daemon polls `~/Library/Messages/chat.db` (or listens to Messages.app notifications), extracts new messages, POSTs to DCC's `receive-sms` (or a new `receive-imessage` function) with `{ from, body, is_group, group_participants, received_at }`. DCC applies the same routing rule as SMS.
- **Channel field:** `messages_outbound` needs `channel text check (channel in ('sms','imessage'))`, defaulting to `sms`. Store which rail the message went over so the UI can show the blue-vs-green bubble affordance.
- **Group iMessage:** the bridge should surface the participant list. Store in `message_groups.participants`.

Out of scope for v1: iMessage reactions, typing indicators, read receipts (nice-to-have later).

---

## 6. What Nathan's DCC session has already built that overlaps

- `contacts` + `contact_deals` are ready. A `contacts.kind` field lets you tag role (`homeowner` / `spouse` / `family` / `neighbor` / `attorney` / `partner` / `vendor` / etc.). Use this as the enum for the "relationship" picker.
- Auto-sync trigger `tg_sync_attorney_assignments_from_contact_deal` means linking an attorney-kind contact to a deal auto-creates portal access. **Do not manually insert into `attorney_assignments`** — see CLAUDE.md.
- `log_deal_activity` RPC — if you want to log "SMS conversation opened with [Maria Jennings]" as a first-class activity, call this from `DealConversations` when a new thread is started.
- Unified Timeline already listens to `messages_outbound` realtime — no subscription work needed on the DCC side.

---

## 7. Open questions for Nathan

1. **Group text = one conversation or N separate threads?** iMessage natively supports group chat; SMS does not. When Nathan sends to 3 people via SMS, should DCC render it as one grouped row (with 3 reply branches) or as 3 separate threads? *Recommendation: group row for iMessage, separate threads for SMS.*
2. **Contact privacy.** If a family member texts in and asks Nathan to keep something from the homeowner ("don't tell my mom dad is drinking again"), does DCC need a "do not show to client portal" flag on the conversation? *Leaning yes — add a `private_to_team` boolean on the thread.*
3. **iMessage identifier.** Phone number (+1…) or Apple ID (email)? Daemon needs to handle both.
4. **Opt-out compliance.** If an unknown contact replies STOP, they need to be marked unsubscribed globally, not just on that deal's thread. Suggest a `contacts.sms_unsubscribed_at` column that `send-sms` checks before sending.
5. **Archive / dismiss conversations.** A thread that was wrong-number noise shouldn't clutter the list forever. Add a `messages_outbound_threads` table with `hidden_at timestamp` OR a `deal_id + thread_key` view row.

---

## 8. Proposed build order

1. Schema changes: `contact_id`, `thread_key`, `channel` on `messages_outbound`. `message_groups` table. `messages_outbound_unmatched` table. Backfill `thread_key` for existing rows.
2. Update `receive-sms` routing logic. Inbound from homeowner phone → auto-contact stub. Inbound from unknown → unmatched queue.
3. Build `DealConversations` component (replaces `OutboundMessages` in `index.html` at line ~3234).
4. Build "Unknown contact" triage banner + the Unmatched SMS admin view.
5. iMessage bridge — daemon skeleton, send path first, then receive path.
6. Group text send/receive via iMessage.
7. Group text via SMS (fan-out per recipient).
8. Opt-out handling + privacy flags.

---

## 9. Where to coordinate

- **This file** — keep updated as spec evolves. Nathan's Claude will read it before touching anything in the SMS lane.
- **`WORKING_ON.md`** (doesn't exist yet — create it when you start) — per-session lock file per CLAUDE.md co-coding protocol.
- **Migration filenames** — follow the `YYYYMMDDHHMMSS_name.sql` pattern, increment by 1s from the latest. Latest as of 2026-04-22 is `20260422220002_docket_event_auto_task.sql`.
- **DCC components affected** — `OutboundMessages` (line ~6620 in `index.html`), `Activity` timeline merge (~6504), `SendIntroTextModal` (~1108).

---

## 10. One-line pitch for Nathan

*"Every conversation on a case — homeowner, family, neighbor, attorney, group text, SMS, iMessage — shows up in one place on the deal, grouped by who you're talking to, so you stop losing threads in your iPhone."*
