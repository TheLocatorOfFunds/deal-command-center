# Bridge group-detection + receive-sms opt-out — Spec for Justin

**From:** Nathan's DCC Claude session, 2026-04-23
**For:** Justin's Claude session (mac-bridge + receive-sms)
**Status:** spec, not yet built — bugs observed in production today
**Owner:** Justin (mac-bridge + receive-sms are his lane)

---

## 0. The two bugs Nathan flagged today

### Bug 1: Group iMessage tapbacks land in separate per-contact threads

Brianna Allen (Homeowner) and Alek Allen (Child) are both in an iMessage
group chat with Nathan. Nathan sent one message to the group; both
Brianna and Alek "liked" it. DCC rendered TWO identical-looking
tapback bubbles — one in Brianna's tab, one in Alek's tab — instead
of ONE group thread with two reactions stacked.

Root cause: `mac-bridge/bridge.js` polls `~/Library/Messages/chat.db`
and writes each row it finds as its own `messages_outbound` row. It
looks at the single sender's phone to set `thread_key` (via
`receive-sms`, presumably), so two reactors on the same group message
produce two separate single-contact thread_keys.

What should happen: when the bridge detects a message on a group chat
(chat.db has a `chat_handle_join` table mapping messages to group
chat rooms with multiple participants), it should:
1. Look up or create a `message_groups` row for that group, keyed by
   something stable like the Apple `chat.guid`.
2. Set `thread_key = <deal_id>:group:<message_groups.id>` on every
   message from that chat.
3. Set `group_id = <message_groups.id>` on every such message.

Then the DCC UI (which already derives `groupThreads` from
`thread_key.includes(':group:')`) renders one group tab. Tapbacks
from multiple reactors stack as two pill-style reactions on the same
quoted message instead of two separate bubbles.

### Bug 2: Inbound texts from random numbers still land in DCC

Nathan's preference: if a phone number texts in and is NOT linked to
any open deal via `contacts.phone → contact_deals`, the text should
NOT create a row in DCC (or should at least not surface in the UI).

Current behavior: `receive-sms` writes unknown-sender rows to
`messages_outbound_unmatched` for later triage. The DCC UI shows a
warning banner ("Unknown contact texted this case") so Nathan can
triage. Nathan says he doesn't want to triage — he wants unknowns to
silently not appear.

### Bug 3 (mirrored — already fixed): same for Voice

I already redeployed `twilio-voice` (Nathan's Voice Edge Function) to
skip logging when the caller isn't linked. Unknown callers still get
forwarded to Nathan's iPhone but never write a `call_logs` row. The
SMS side needs the equivalent treatment.

---

## 1. Context on the data

- `mac-bridge/bridge.js` — Justin's Node daemon on the Mac Mini.
  Polls chat.db every 5s, inserts into `messages_outbound`.
- `messages_outbound` (from Justin's multi-contact merge):
  `contact_id`, `thread_key`, `channel`, `group_id`
- `message_groups` (from Justin's multi-contact merge):
  `id`, `deal_id`, `label`, `participants jsonb`, `channel`, `created_at`
- `receive-sms` — Twilio inbound webhook. Already has contact-aware
  routing but falls back to `messages_outbound_unmatched` for unknowns.

---

## 2. Fix 1 — bridge group detection

### Steps

1. When polling chat.db, `JOIN` the `chat` and `chat_handle_join` tables:

```sql
-- pseudocode; real query in bridge.js
SELECT message.ROWID, message.text, message.is_from_me,
       handle.id AS sender_phone,
       chat.guid AS chat_guid,
       chat.display_name,
       (SELECT COUNT(*) FROM chat_handle_join WHERE chat_id = chat.ROWID) AS participant_count
FROM message
JOIN chat_message_join ON chat_message_join.message_id = message.ROWID
JOIN chat ON chat.ROWID = chat_message_join.chat_id
LEFT JOIN handle ON handle.ROWID = message.handle_id
WHERE message.ROWID > :watermark;
```

2. If `participant_count > 1` (it's a group chat):
   - Look up an existing `message_groups` row where
     `participants @> '[{"apple_chat_guid":"<chat.guid>"}]'` (store the
     Apple chat guid in the participants jsonb so the next bridge tick
     can re-find it).
   - If none exists, route the chat participants through
     `contacts.phone → contact_deals → deal_id` to find which deal the
     group belongs to. If multiple deals match (e.g., attorney is in
     multiple case groups), fail closed — leave the message in
     `messages_outbound_unmatched` for manual triage.
   - Insert a new `message_groups` row:
     ```js
     {
       deal_id: matched_deal_id,
       label: chat.display_name || participant_names.join(' + '),
       participants: [
         { phone: ..., contact_id: ..., name: ... },
         ...,
         { apple_chat_guid: chat.guid }  // embed this so we can re-find
       ],
       channel: 'imessage'
     }
     ```
3. For the inbound message itself:
   - `thread_key = '<deal_id>:group:<message_groups.id>'`
   - `group_id = message_groups.id`
   - `contact_id = <sender's contact_id>` (still attribute who sent it)

4. Tapback normalization: the bridge already normalizes tapbacks to
   `"👍 reacted to: '…'"`. Keep that, but ALSO store the `associated_message_guid`
   somewhere so the UI can later stack multiple tapbacks on the same
   quoted message. For v1, two reactions showing as two bubbles in the
   group tab is acceptable — the important thing is they land in ONE
   tab, not two.

### DCC UI impact

None. The UI already derives `groupThreads` from messages with a
`thread_key` containing `:group:`. Once the bridge stamps these
correctly, the group tab appears automatically for Brianna + Alek's
thread and the two tapbacks stack inside it.

---

## 3. Fix 2 — receive-sms unknown-sender drop

### Current code (pseudocode)

```ts
// receive-sms logic today:
const dealId = await lookupDealByPhone(fromNumber);
if (dealId) {
  await db.from('messages_outbound').insert({ ... });
} else {
  await db.from('messages_outbound_unmatched').insert({ ... });  // <-- drop this
}
```

### Proposed

Option A — hard drop:
```ts
if (dealId) {
  await db.from('messages_outbound').insert({ ... });
} // else: silently ignore, return <Response/> to Twilio
```

Option B — soft drop (recommended): keep the row in
`messages_outbound_unmatched` but stop surfacing it in the DCC UI.
The row is still there for audit / later triage, but Nathan never
sees a banner. I already filter the unmatched-contact banner on the
DCC side to only show rows where `to_number` matches an existing
contact on the current deal — unknown-unknown rows won't display.
Justin's bridge / receive-sms side doesn't need to change for this to
work at the UI level.

**Recommend Option B** — keeps the audit trail in case of compliance
questions about what was ignored, but invisible to Nathan by default.

If Nathan later wants to see everything that's been dropped, add an
admin-only "📥 Unmatched SMS" modal (mentioned in my earlier
multi-contact spec — §4E) that queries
`messages_outbound_unmatched.resolved_at IS NULL AND dismissed = false`
across ALL deals. He can spot-check trash from real leads there.

---

## 4. Side note — outbound group send today works through fan-out

The DCC group-compose panel I just shipped sends one send-sms call per
selected recipient. This works for SMS recipients but means iMessage
contacts get individual iMessages, not a single group iMessage.

For true iMessage group send, the mac-bridge would need to:
- Accept a `group_id` or `recipients[]` parameter in its outbound poll
- Compose an AppleScript that creates or targets an existing
  Messages.app group thread (this is non-trivial — Messages.app
  group chats are identified by `chat.guid` and AppleScript access
  is spotty).

For v1 the fan-out path is acceptable. Nathan just needs to know
"this is effectively a broadcast for now; replies come back to
individual threads; see the Everyone tab for the merged view."

---

## 5. Suggested build order for Justin

1. **Fix 2 isn't needed** — UI already hides unknowns from Nathan; no
   bridge / receive-sms change required unless Nathan wants the DB
   cleaner. Skip unless asked.
2. **Fix 1 (group detection in bridge)** — this is the real bug.
   Single session, probably 1–2 hours, entirely in
   `mac-bridge/bridge.js`. Test by having Nathan send a group
   iMessage from his iPhone and confirming DCC renders it as a group
   tab with both reactions inside.
3. **Group iMessage send through bridge** — nice-to-have, defer.

---

## 6. One-line pitch for Nathan (so he can follow what's happening)

*"The bridge sees each person's 'Like' on a group text as a separate
incoming message. It needs to recognize 'this came from a group chat'
and assign all messages from that chat the same group thread_key so
DCC renders them together."*
