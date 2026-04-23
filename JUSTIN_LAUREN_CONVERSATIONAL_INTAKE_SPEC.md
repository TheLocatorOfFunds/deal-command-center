# Lauren-Driven Conversational Intake — Spec for Justin

**From:** Nathan's DCC Claude session, 2026-04-23
**For:** Justin's Claude session (Lauren + SMS lanes)
**Status:** spec, not yet built
**Owner:** Justin (per [CLAUDE.md](CLAUDE.md) domain table — Lauren + pgvector + SMS/iMessage bridge are all Justin-lane)

---

## 0. Read this first

Today homeowners intake their case by clicking a link to a 5-step web form (`homeowner-intake.html`). Casey Jennings got one yesterday; she opened it, hasn't submitted. Link-based forms convert poorly. Nathan's idea: **have Lauren text the homeowner and ask the intake questions conversationally**, parse replies in natural language, and auto-populate the same `deals.meta.investor.homeowner_said` + promoted fields that the form populates today.

Goal: form data that feels like a chat with Nathan, not a survey. Higher completion rate, zero drop-off clicks, zero friction.

Nathan is non-technical. Summarize implementation details in this file + WORKING_ON.md; brief him in business-first language.

---

## 1. Business pitch

Casey gets a text from Nathan's number:
> Hi Casey — Nathan here at RefundLocators. To put together your case I have a few questions about the property at 121 Main St. Just text back, no forms, takes ~5 min. Ready?

She replies "yeah go ahead". Lauren asks the first question. Casey types a sentence. Lauren parses, stores, asks the next. Every answer auto-lands in Casey's deal in DCC — Nathan watches it fill in live. Lauren can clarify ("you said 3 bed, does that include the basement bedroom?"), skip when she doesn't know ("no problem, we can figure that out later"), and close gracefully when done.

Nathan can jump in mid-conversation — Lauren backs off the moment she sees a real human reply from his side.

---

## 2. Current state (what exists + what's missing)

### What works today ✅
- **Static intake form** (`homeowner-intake.html`) — 5-step wizard, calls `submit_homeowner_intake(token, data)` RPC on finish. Writes to `deals.meta.investor.homeowner_said` + promoted fields, flips `homeowner_intake_access.completed_at`, logs activity.
- **Display** — new `HomeownerIntakeResponses` card on the deal Overview renders everything from `meta.investor.homeowner_said` verbatim, grouped by topic. Works identically whether data came from the form or from SMS.
- **Outbound SMS** — `send-sms` Edge Function, 16 successful sends, messages_outbound logging.
- **Inbound SMS** — `receive-sms` Edge Function inserts into messages_outbound.
- **Lauren pgvector** — foundational embedding store lives (Justin). Chat agent not yet production-wired.
- **SMS templates** — tier-based outbound templates in `sms_templates`. Merge vars: [FirstName], [OwnerName], [sale_date], [token], [County].

### What's missing ❌
- **Intake question bank as data** — today the questions are hardcoded in `homeowner-intake.html` JSX. No structured source of truth Lauren can read from.
- **Session state machine** — no table tracking "Casey is on question 7, here's what she's answered so far, here's what's next."
- **LLM-backed reply parser** — when Casey texts "yeah it's been leaking since last summer, 3 kids upstairs bedrooms also the furnace went out", Lauren needs to extract `{roof: "leaks since summer", beds: 3, hvac: "furnace out"}` and decide whether to probe or move on.
- **Lauren-as-agent** — Lauren needs to drive the conversation (send next question on her own schedule, not just respond to messages). This is the biggest new capability.
- **Nathan-takeover handoff** — when Nathan texts from his side of the thread, Lauren pauses until he explicitly hands back ("go ahead, keep asking her").
- **Opt-out handling** — "STOP" replies need to unsubscribe the contact globally + pause the session gracefully.

---

## 3. Data model

### 3.1 Question bank — `public.intake_questions`

```sql
create table public.intake_questions (
  id uuid primary key default gen_random_uuid(),
  sort_order int not null,
  key text not null,             -- matches keys in homeowner_said (e.g. 'beds', 'situation')
  category text not null,        -- 'narrative' | 'mortgage' | 'property' | 'condition' | 'contact'
  prompt text not null,          -- the conversational text Lauren sends
  followup_prompts jsonb,        -- optional clarifiers keyed by low-confidence branches
  expected_type text not null,   -- 'number' | 'text' | 'enum' | 'date' | 'yesno'
  enum_values jsonb,             -- for enum types: ['good', 'fair', 'needs_work']
  required boolean not null default false,
  skip_if jsonb,                 -- simple condition, e.g. {"field": "occupancy", "equals": "vacant"}
  active boolean not null default true,
  created_at timestamptz not null default now()
);
```

Seed ~20–30 questions mirroring the current form. Nathan can edit them in DCC later (Phase 2).

### 3.2 Session state machine — `public.intake_sessions`

```sql
create table public.intake_sessions (
  id uuid primary key default gen_random_uuid(),
  deal_id text not null references public.deals(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  channel text not null check (channel in ('sms', 'imessage')),
  phone_e164 text not null,
  status text not null check (status in ('invited', 'active', 'paused_for_nathan', 'opted_out', 'completed', 'abandoned')),
  current_question_id uuid references public.intake_questions(id),
  answers jsonb not null default '{}'::jsonb,    -- accumulated answers, written atomically
  confidence jsonb not null default '{}'::jsonb, -- per-field Claude confidence (0-1)
  nathan_takeover_at timestamptz,                 -- set when Nathan jumps in
  started_at timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  completed_at timestamptz,
  message_count int not null default 0
);

create index idx_intake_sessions_active
  on public.intake_sessions(phone_e164, status)
  where status in ('invited', 'active');
```

One session per deal + phone. When it completes, the `answers` jsonb merges into `deals.meta.investor.homeowner_said` via the same code path `submit_homeowner_intake` uses.

### 3.3 Turn log — reuse existing `messages_outbound`

No new table for the chat turns — they're regular SMS rows. Add two nullable columns:

```sql
alter table public.messages_outbound
  add column if not exists intake_session_id uuid references public.intake_sessions(id) on delete set null,
  add column if not exists ai_generated boolean not null default false;
```

`ai_generated=true` flags messages Lauren wrote (so UI can render a subtle "🤖 Lauren" attribution). `intake_session_id` groups the turns per session.

---

## 4. Lauren agent loop (new Edge Function: `lauren-intake-step`)

### Trigger
- On every `INSERT` into `messages_outbound` where `direction='inbound'` AND the sender phone has an active intake_session → invoke `lauren-intake-step`.
- Also invokable manually from DCC for the initial "kick off session" message.

### Logic (pseudocode)

```typescript
async function lauren_intake_step(session_id: uuid, inbound_msg?: string) {
  const s = await load_session(session_id);
  if (s.status !== 'active') return;
  if (s.nathan_takeover_at) return; // Nathan is driving, stay out

  // 1. Parse the inbound reply against the current question
  if (inbound_msg && s.current_question_id) {
    const q = await load_question(s.current_question_id);
    const parsed = await claude_parse(inbound_msg, q, s.answers); // Anthropic API call
    //   parsed = { value: <typed>, confidence: 0.0–1.0, needs_clarification: bool, opt_out: bool }

    if (parsed.opt_out) {
      await update_session(s.id, { status: 'opted_out' });
      await send_sms(s, "No problem, I won't text you again about this. If you change your mind reply YES.");
      return;
    }

    if (parsed.needs_clarification && q.followup_prompts) {
      await send_sms(s, claude_pick_followup(q, parsed, inbound_msg));
      return;
    }

    await merge_answer(s, q.key, parsed.value, parsed.confidence);
  }

  // 2. Pick next question
  const next = await pick_next_question(s);
  if (!next) {
    await finalize_session(s); // merges answers into deals.meta.investor.homeowner_said
    await send_sms(s, "That's everything — thanks Casey. Nathan will review and text you back with next steps.");
    return;
  }

  // 3. Send it
  await update_session(s.id, { current_question_id: next.id });
  await send_sms(s, next.prompt);
}
```

### Claude API prompt for parsing

One structured prompt (system + user) that returns JSON:

```
SYSTEM: You are parsing a homeowner's reply to a single question during an intake
conversation for a foreclosure surplus recovery case. Return ONLY a JSON object:
{ "value": <parsed-value>, "confidence": 0.0-1.0, "needs_clarification": boolean,
  "opt_out": boolean, "reasoning": "..." }

USER: Question asked: "{q.prompt}"
Expected type: {q.expected_type}
Valid values (if enum): {q.enum_values}
Homeowner replied: "{inbound_msg}"
Context (what we already know): {s.answers as compact JSON}
```

Confidence < 0.5 should trigger `needs_clarification=true` if a followup prompt exists.

### Nathan-takeover detection

When a message lands in this deal's thread from a non-`ai_generated` non-homeowner sender (i.e. Nathan texting from his number), flip `intake_sessions.status = 'paused_for_nathan'` and set `nathan_takeover_at = now()`. UI shows "⏸ Paused — Nathan is driving this conversation." Button to resume: `POST /lauren-intake-resume` flips it back to 'active' and sends Lauren's next question.

---

## 5. DCC UI additions (this is Nathan-lane — I can build once Justin ships the backend)

### A. Replace the "Generate intake link" button with a choice
On the HomeownerIntakeCard:
- `📋 Send intake link` (existing behavior)
- `💬 Text Lauren to ask them` (new) — creates an `intake_session`, sends the kick-off message via Lauren, surfaces the thread.

### B. Live session banner on deal detail
When an active intake_session exists, top of the deal shows:
> 🤖 Lauren is talking to Casey · question 7 of 24 · last reply 4 min ago · [Pause] [View thread]

### C. Session progress card
Near HomeownerIntakeResponses, a new `IntakeSessionCard` showing:
- Questions answered / total
- Low-confidence answers flagged for Nathan review
- Button: "Jump into the thread" → opens the SMS tab filtered to this session
- Button: "Hand off to me" → pauses Lauren

### D. Conversation rendering (builds on Justin's multi-contact spec)
When messages_outbound rows have `ai_generated=true`, render with a subtle 🤖 prefix + a slightly different bubble color so Nathan can instantly see which side was Lauren vs himself.

---

## 6. Integration points with existing specs

- **Multi-contact conversation view** ([JUSTIN_MULTI_CONTACT_SMS_SPEC.md](JUSTIN_MULTI_CONTACT_SMS_SPEC.md)) — Lauren intake runs on the homeowner's thread specifically. `thread_key = '<deal_id>:contact:<homeowner_contact_id>'`. If the homeowner's phone isn't yet in `contacts`, Lauren's kick-off creates the stub automatically.
- **Cadence engine** (proposed in the what-do-we-need-to-do-for-GHL response) — Lauren intake IS a cadence: one per lead, kick-off on qualification, runs on its own rhythm.
- **Send Intro Text** — remains the manual kick-off. Once Justin ships this, Nathan can pick "Lauren version" or "just send the link" version per deal.
- **Display card** ([HomeownerIntakeResponses](index.html) — shipped today) — renders whether data came from the form or from Lauren's session. Zero downstream work needed there.

---

## 7. Open questions for Nathan

1. **Lauren's persona.** She's texting as herself or as Nathan? Leaning: "Hi Casey, I'm Lauren, I work with Nathan at RefundLocators. Nathan asked me to grab a few details so he can put a plan together for you." Authentic, no deception.
2. **Explicit consent to AI.** FTC/FCC guidance evolving on automated text outreach. Conservative move: first message discloses "I'm a virtual assistant" to avoid deception complaints. Aggressive move: only disclose if asked. *Recommend conservative by default, admin can toggle per-deal.*
3. **What happens when Lauren gets stuck?** e.g., homeowner asks a medical question, or something Lauren can't answer. Option A: Lauren says "Let me get Nathan, hold on" and pauses. Option B: Lauren hallucinates. *Option A only — never guess.*
4. **Concurrent sessions.** Can Lauren run 20 intakes at once? Twilio rate limits + Claude rate limits say yes but consider: if Nathan's phone is the `from_number`, 20 concurrent conversations from one number to 20 recipients looks spammy. Might need to rotate through `phone_numbers` or queue/pace.
5. **Confidence threshold for auto-merge vs. flag-for-review.** *Suggest: >0.85 auto-merge. 0.5–0.85 auto-merge with a yellow flag in the UI. <0.5 ask for clarification first.*
6. **Opt-out persistence.** If Casey opts out of intake, does that opt her out of ALL SMS? Legally, yes — STOP = global. Implementation: `contacts.sms_unsubscribed_at` from the multi-contact spec.
7. **Intake questions editing.** Phase 1: hardcoded seed. Phase 2: DCC UI to edit `intake_questions`. *Ship Phase 1 first; don't build the editor until the conversational flow is proven.*
8. **Language.** Spanish-speaking homeowners are a real segment. Lauren should detect language from the first reply and switch. *Ship English v1; add Spanish once flow is validated.*

---

## 8. Proposed build order

1. Schema — `intake_questions`, `intake_sessions`, alter `messages_outbound`.
2. Seed intake_questions with ~25 questions matching current form.
3. `lauren-intake-step` Edge Function — the core loop, Claude parsing, SMS send.
4. Inbound routing hook — when receive-sms matches an active session phone, fire `lauren-intake-step`.
5. Kick-off path — new RPC `start_lauren_intake(deal_id, phone, contact_id?)` that creates the session and sends the first message.
6. DCC UI:
   - "Text Lauren to ask them" button on HomeownerIntakeCard.
   - Live session banner on deal detail.
   - IntakeSessionCard with progress + low-confidence review.
   - 🤖 attribution on AI-generated messages_outbound rows.
7. Nathan-takeover detection + resume button.
8. Opt-out + pause + abandonment cleanup (sessions idle >72h auto-marked `abandoned`).
9. Phase 2: question-bank editor, Spanish support, multi-number rotation.

---

## 9. Existing Lauren infrastructure to build on

Justin's pgvector work — likely already has:
- Embedding store for semantic search
- A `lauren_conversations` or similar table
- An Edge Function for chat

Reuse these where possible. Specifically: the `claude_parse` step in §4 could live inside Justin's existing `lauren-chat` Edge Function with a new `mode='intake_parse'` path, rather than a separate Edge Function.

---

## 10. One-line pitch for Nathan

*"Instead of texting homeowners a form to fill out, Lauren just texts them the questions one at a time and I watch their answers show up on the deal in real time."*
