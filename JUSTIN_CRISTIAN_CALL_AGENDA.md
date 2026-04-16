# Call with Cristian — Agenda for Justin

**Purpose:** Bring Cristian up to speed on RefundLocators.com and the product pivot; validate what we observed in the N8N workflow; get his read on what's risky vs. cheap to extend; and decide how we work together going forward.

**Frame the call this way:** *"Cristian, what you built is solid — it's our foundation. We need your help extending it for a bigger product vision. We also want to make sure we understand what you built before we accidentally break anything."*

**Before the call:** Send Cristian the `REFUNDLOCATORS_VISION.md` file and ask him to skim §5 (the 10 category-killer moves) and §6 (AI engine, empathy questions, bankruptcy flow, DIY policy). That gives him 20 minutes of async context so the call can focus on technical depth rather than product storytelling.

---

## Part 1 — Context for Cristian (5–10 min, Justin talks)

Walk him through these four things in order. Don't skip #2 — he has NOT seen the Vision doc yet and needs the pivot context before he can answer technical questions well.

### 1. The business as it exists today
FundLocators is the B2B/ops brand. Castle scrapes NOD + sheriff sale data from Hamilton, Warren, Butler counties (and statewide Ohio for sheriff sales), enriches with BatchData, pushes into GHL. The Lauren chatbot he built does appointment-setting for leads who reply to outbound SMS. That's working.

### 2. The pivot — RefundLocators.com
We're launching a **consumer-facing brand** that flips the playbook. Instead of cold-calling foreclosure victims, we let them come to us. Site is live at refundlocators.com (Cloudflare Pages). Vision: someone types their address, sees their surplus amount in 30 seconds, chats with an AI, signs a DocuSign by text — **without ever speaking to a salesperson if they don't want to**. The differentiator is radical transparency + an AI trained on Ohio foreclosure law + dignity-first conversation design.

### 3. Why this matters for Lauren
Lauren today is an appointment-setter. The Vision doc needs her to be a full-service self-serve agent that can:
- Talk through surplus recovery end-to-end
- Offer TWO paths (schedule a call OR sign a DocuSign by text) — not just the call path
- Ask 5 empathy questions ("Were you the only one on the deed?", "Are you still in the house?", "Do you have food?")
- Show fees to the penny
- Handle compliance edge cases (bankruptcy qualification, self-harm crisis, STOP, AI disclosure when asked)
- Apply GHL tags mid-conversation to route leads into different nurture flows

We're NOT replacing Lauren. We're evolving her. His work is the foundation.

### 4. Claude is helping us architect this
Nathan is working with Claude (AI pair-programmer) to map the full product. Claude has read the N8N workflow end-to-end (read-only, nothing modified) and written the Vision doc. Cristian will likely interact with Claude sessions going forward — either through Nathan/Justin, or directly if we add him to our setup.

### 5. Transparency about parallel work
Before we knew Lauren existed, two other Claude sessions scaffolded SMS bots in Python + TypeScript on Nathan's laptop. Both are being deleted. They were built in ignorance, not as replacements for Cristian's work. The N8N workflow is the path forward.

---

## Part 2 — Validate what we observed in N8N (10 min, Cristian talks)

Tell Cristian: *"I ran through the GHL Chatbot workflow. I want to confirm I understand what's there. Correct me where I'm wrong."*

Then read him this summary and have him confirm / correct each line:

| What we think we see | Ask him |
|---|---|
| Lauren uses GPT-5, not GPT-4o (the node is mislabeled) | "Did you upgrade to GPT-5 recently? Anything we should watch at scale?" |
| Postgres memory table `n8n_chat_histories`, 6-message context window | "Where is this Postgres hosted? What session key identifies a user — is it the GHL `contactId`?" |
| Supabase pgvector for RAG, OpenAI `text-embedding-3-small`, top-3 chunks, no reranker | "Which Supabase project? Same as our DCC Supabase (`fmrtiaszjfoaeghboycn`) or separate?" |
| 4 tools: `schedule_appointment`, `get_free_slots`, `handoff_to_human`, `search_knowledge_base` | "Any tools I missed or tools that are stubbed out?" |
| `handoff_to_human` adds `handsoff` tag to GHL contact | "What triggers Nathan's alert after the tag is added — a GHL workflow on tag change?" |
| Webhook path `/webhook`, POST, receives GHL's customData payload with case intelligence | "What sends data to this webhook? A GHL workflow on inbound SMS? What's the full webhook URL?" |
| Response goes back via `GoHighLevel (Update Only)1` HTTP node | "How does that HTTP call become an outbound SMS to the lead?" |
| `Split Answers (New)1` calls GPT-5 a second time to chunk into JSON multi-message output | "Why two models? SMS length limit handling?" |
| Timezone: America/Indiana/Indianapolis | "Any plan to support multi-timezone when we add other states?" |
| Knowledge base loaded via an N8N form (`On form submission` trigger) | "Who uploads to the knowledge base today? What format — PDFs, text, Nathan's call transcripts?" |

### The landmine question
**"What is the 'Don't touch' node at the bottom of the workflow? Why is it labeled that?"**

It's a GET HTTP node with no description and a suspicious label. We need to know what it does before we extend anything. Do not skip this question.

---

## Part 3 — The gap map (5 min)

Share the table below. These are the places Lauren falls short of what the Vision doc wants. Ask him which are easy, which are hard, which are risky.

| Gap | Nathan's guess at effort |
|---|---|
| Add DocuSign self-serve signing path (text the agreement as an alternative to booking a call) | Medium |
| Add `calculate_payout` tool (fee to the penny — input: surplus amount, output: fee + net) | Small |
| Add empathy question flow (5 questions from Vision §6.5) | Small — prompt change |
| Add AI disclosure rule (must say "yes I'm an AI" when asked) | Trivial |
| **Add bankruptcy qualification flow** (4 questions, 4 GHL tags, monthly nurture for `BK-active`) | Small — prompt + new tool |
| Add self-harm / crisis protocol with resources | Small but urgent — compliance |
| **Add DIY acknowledgment** — AI confirms DIY is real, offers to walk through it on a phone call; does NOT paste form/fee/procedural steps into text | Small — prompt change |
| Web-search intake (Lisa types address on refundlocators.com → new webhook → GHL contact → confirmation SMS) | Medium — new workflow |
| Deal write-on-sign → DCC Supabase | Medium — new tool |
| Expand memory from 6 to ~20 messages for long conversations | Trivial |
| `set_contact_tag(tag_name)` tool — apply arbitrary GHL tag mid-conversation | Small — new tool |
| Post-sign experience (dashboard, weekly status text, payout celebration) | Large — Phase 3, not urgent |

Don't let him commit to timelines on the call. Just ask: *"If you had to rank these by risk, what would you do first and what would scare you?"* His gut read is more valuable than his estimate.

---

## Part 4 — Architectural questions (10 min)

These are the decisions we need his opinion on:

1. **"Should Lauren stay in N8N, or is this the time to move her to a dedicated Python service?"** Nathan wants ONE agent. Cristian's opinion on whether N8N can handle the evolved bot matters. If he thinks N8N will get brittle at this scope, we want to know now.

2. **"Do you want to build the evolution, or would you rather hand off the codebase and consult?"** Be honest. If he's at capacity, we hire someone. If he wants to lead it, great. We need to know.

3. **"What would break if we bumped memory from 6 to 20 messages?"** Postgres sizing, token cost, latency. His call.

4. **"Should the web-search intake (for refundlocators.com visitors) be a second N8N workflow, or a separate service?"** He'll know what's easier to maintain.

5. **"Is the Supabase for the vector store the same as our DCC Supabase (`fmrtiaszjfoaeghboycn`), or a separate project?"** This matters because DCC is the system of record. If it's the same Supabase, we can write signed deals straight into DCC's `deals` table. If it's separate, we need a cross-DB write pattern.

6. **"Does GHL already have tag-based workflow routing?"** We need `BK-active`, `BK-cleared`, `BK-considered`, `BK-unknown` tags to each trigger a different cadence (monthly nurture for `BK-active`, normal flow for `BK-cleared`, etc.). If GHL routes on tags natively, great. If not, where does that logic live — a new N8N workflow that consumes GHL webhooks?

7. **"What's the cleanest way for Lauren to apply a GHL tag mid-conversation?"** We'll need it for BK routing, DIY-interested, high-equity, and more down the line. Is there a `set_tag` tool pattern we can add next to `handoff_to_human`?

8. **"For the monthly BK nurture — should the monthly check-in message be sent by GHL's native drip, or generated by Lauren each time (more dynamic, references the homeowner's specific case and last conversation)?"**

9. **"Is there a call-scheduling path for someone who ONLY wants DIY help (not to hire us)?"** Nathan wants the AI to offer to walk through DIY on a call regardless of whether they hire us. That might mean a second appointment type in GHL.

---

## Part 5 — What we need from Cristian (5 min)

This is the "deliverables" part. Be direct and polite.

1. **A 15-minute Loom video** walking through the full N8N workflow — every node, what it does, why it's there. Something we can rewatch when he's not available.

2. **A `README.md` committed somewhere** with:
   - Architecture overview (what's in N8N, what's in Supabase, what's in Postgres, what's in GHL)
   - Credential list (names only, not values — which accounts own what)
   - Deployment model (where is the N8N instance running, who owns the Hostinger account, what's the backup story)
   - The "Don't touch" node documented

3. **Read access for Justin and Nathan** to the N8N instance (if they don't have it). Read-only user role.

4. **Read access to Castle** — whatever form makes sense (GitHub repo invite, architecture doc, or a 10-minute walkthrough).

5. **Supabase access** — add Justin/Nathan as read-only members, or share an anon key we can use for development.

6. **His weekly availability + rate** — we need to know what we're budgeting for. Hourly, project-based, retainer? And what hours he's online in Colombia time zone vs. US Eastern.

---

## Part 6 — Key scripts to hand Cristian

These are the exact conversational turns Lauren needs to support. He can decide whether they go into the system prompt, as tool responses, or as structured output formats.

### DIY policy (soft, phone-call-led)

> **User:** "Can I just do this myself?"
>
> **Lauren:** "Absolutely — you can file this claim yourself at your county court of common pleas. It's not a secret. The reason most people have us do it is Ohio has a few procedural steps that trip people up and a filed claim on the wrong form gets kicked back. If you want to go DIY, I'd love to walk you through the steps on a quick call — it's the part that's hard to cover in a text. Want me to grab a time for that?"

**The AI never pastes the form, filing fee, or procedural steps into the chat.** The walk-through happens on a call. DIY exists; the blueprint is delivered verbally.

### Bankruptcy qualification flow (4 questions, then route)

> **User:** "I filed BK already"
>
> **Lauren:** "Appreciate you mentioning that — did you actually file, or were you considering it?"
>
> **User:** "I filed"
>
> **Lauren:** "Was it a Chapter 7 or a Chapter 13?"
>
> **User:** "Chapter 7"
>
> **Lauren:** "When did you file, roughly — what month and year?"
>
> **User:** "About six months ago"
>
> **Lauren:** "Got it. Has it been discharged or dismissed yet, or is it still open?"
>
> **User:** "Still open"
>
> **Lauren:** *[calls `set_contact_tag` tool with `BK-active`]* "Thanks for letting me know. While your case is open, we don't want to step on your bankruptcy attorney's work. We'll check in with you once a month — when it's discharged we can pick up the surplus conversation. Hang in there."

### Routing table (implement as either GHL workflows or N8N branching)

| Answer pattern | GHL tag | Cadence | Lauren's closing line |
|---|---|---|---|
| Filed, still open | `BK-active` | **Monthly nurture only** | *"While your case is open, we don't want to step on your bankruptcy attorney's work. We'll check in once a month."* |
| Filed, discharged/dismissed | `BK-cleared` | Normal flow | *"Since it's behind you, the surplus piece is usually yours again. Want to walk through what we found?"* |
| Considered but didn't file | `BK-considered` | Normal flow (flagged as financially stressed — extra care on fee framing) | *"Understood. Let me walk you through what the surplus recovery looks like — there's no cost to you upfront either way."* |
| Refused to answer | `BK-unknown` | Soft nurture only | *"No problem, you don't have to tell me anything you don't want to. We can pick it up whenever works for you."* |

### Monthly nurture messages (rotate for `BK-active`)

- *"Hey [name], just checking in. How's everything going with your case? We're here whenever the time is right."*
- *"Thinking of you this month. If anything changes with your bankruptcy status, let me know and we'll pick up where we left off."*
- *"Quick check-in — no pressure, no sales talk. Just wanted to make sure you're doing okay."*

---

## Part 7 — Tone and positioning reminders for Justin

- **Do not say "we're pivoting away from appointment-setting"** — that's not true. Appointment-setting stays a path for leads who prefer a call. We're adding a SECOND path (self-serve text-to-sign) alongside it.
- **Do not say "Claude built this" or "AI wrote this"** — Cristian may feel defensive. Frame it as "we've been planning a bigger product vision and want to extend what you built."
- **Do not ask him to commit to a timeline on the call.** He needs time to read the Vision doc and think. Ask for a follow-up in 3–5 business days with his scoped proposal.
- **Do praise what he built.** Lauren is well-architected — strict tool sequencing, error handling with retry, hard overrides to prevent hallucinations, JSON response splitter for SMS. That's real craft. Name it.
- **Be honest about two other Claude sessions having written parallel bots (Python + TypeScript).** He'll find out eventually. Tell him they were built before we knew Lauren existed, they're being deleted, and his work is the foundation going forward.
- **On the BK change:** frame it as business-positive, not compliance. *"We found a way to stay compliant AND stay in touch. The pipeline gets bigger this way — BK leads aren't dead, they're just on a slower cadence."* That framing makes the change feel like an upgrade to him, not a correction.

---

## The three things that MUST come out of this call

1. **Full credentials / access map.** Who owns what. This is the riskiest thing to leave undocumented with a solo outsourced dev.
2. **His answer on "extend vs. hand off."** Changes everything downstream.
3. **What the "Don't touch" node does.** Until we know, we can't safely change anything.

Everything else can be a follow-up.

---

## After the call

1. Record the call (Granola or Zoom recording).
2. Send Nathan + Claude the recording/transcript.
3. Claude will update the context docs (`REFUNDLOCATORS_CONTEXT.md`, `HANDOFF_FROM_DCC_TO_REFUNDLOCATORS.md`) based on what we learn.
4. Schedule the follow-up with Cristian for 3–5 business days out so he has time to read the Vision doc and write a scoped proposal.
