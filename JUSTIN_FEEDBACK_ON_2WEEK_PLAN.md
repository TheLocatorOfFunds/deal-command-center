# Justin's Feedback on the 2-Week Lead Funnel Plan

**Written:** 2026-04-24  
**Reading cold from:** `LEAD_FUNNEL_2WEEK_PLAN.md`

TL;DR: The plan is right directionally. I have one serious blocker you missed (A2P 10DLC), one implementation gap that will bite W1-2 (triggers can't call HTTP directly), one thing that literally doesn't exist yet (Lauren's ingestion pipeline), and I agree with all four skips. Details below.

---

## 1. W1-3 + W1-4 — Blockers you may not see

### W1-3 · Twilio trial upgrade → **A2P 10DLC is the real blocker, not the upgrade**

Upgrading from trial to pay-as-you-go unblocks sending to unverified numbers. That's correct. But it's not sufficient.

**The actual blocker:** Twilio requires A2P 10DLC registration for any programmatic business SMS sent from a 10-digit number. Without it, major carriers (AT&T, Verizon, T-Mobile) will silently filter or block the messages — no error returned, the SMS just never arrives. This is not optional and it's not a Twilio policy, it's a CTIA/carrier requirement that went mandatory in 2023.

What it takes:
- **Brand registration** — $4 one-time, approved in minutes
- **Campaign registration** — ~$10-15/month, takes 1-5 business days to approve (sometimes faster, sometimes longer depending on carrier review)
- Campaign type needed: "Mixed" or "Customer Care" — we're sending outreach to people who haven't opted in, so the campaign application needs to accurately describe that use case

The risk: if we auto-SMS 20 A-leads before 10DLC is registered, messages are filtered and we have no idea. Reply rates will look like zero when the problem is actually delivery.

**My recommendation:** W1-3 should be two sub-tasks: (a) upgrade billing, (b) submit brand + campaign registration the same day. The 10DLC approval window is the real timeline dependency for W1-2 going live, not the code.

I don't own this — Nathan submits the registration form in the Twilio console (Messaging → Regulatory Compliance → A2P 10DLC). But it needs to be in flight on day 1.

---

### W1-4 · iMessage bridge `launchctl load` — low risk, one real dependency

The plist file exists and is correct. The "edit 3 paths" step is accurate:
1. `/usr/local/bin/node` → run `which node` on the Mac Mini to confirm
2. The bridge.js absolute path
3. The WorkingDirectory path

Five minutes of work. The risk isn't the setup — it's the ongoing health assumption. The plan's success criterion is "running for 7 days without crashing." The bridge has a `KeepAlive` plist key that restarts it on crash, but if it crashes in a tight loop (e.g., corrupted chat.db read), `launchctl` will throttle restarts and eventually stop trying.

**One blocker I actually need to ask about:** Is Nathan logged into iMessage on the Mac Mini with his Apple ID? The bridge reads `~/Library/Messages/chat.db` on the Mac Mini. If his iMessages aren't syncing to that machine, the bridge sees nothing regardless of whether the process is running. Confirm this before the 7-day clock starts.

---

## 2. Lauren's ingestion pipeline — current state

**Honest answer: it doesn't exist.**

There is no `lauren_knowledge` table in any migration. There's no pgvector setup, no chunking code, no embedding pipeline, no retrieval function. The `notify-homeowner-intake` edge function exists and handles the intake chatbot flow, but that's a separate thing from a knowledge-retrieval RAG setup.

The week 3 gate says "Justin's `lauren_knowledge` pgvector table has the playbook chunked + embedded." Here's what actually has to be built first:

1. Enable `vector` extension in Supabase (1 SQL line, trivial)
2. Create `lauren_knowledge` table with chunk text + `embedding vector(1536)` column
3. Choose an embedding model — Anthropic doesn't have a native embedding API, so this means OpenAI `text-embedding-3-small` (~$0.02/1M tokens, basically free) or Voyage AI. I'd go OpenAI for simplicity; we already have relationships with Anthropic for Claude but Anthropic doesn't do embeddings.
4. Write a one-shot ingestion script: read the playbook markdown, chunk by section/paragraph, embed each chunk, insert to DB
5. Write a `match_lauren_knowledge(query_embedding vector, match_count int)` RPC that does cosine similarity search
6. Wire retrieval into Lauren's response generation

Timeline from "playbook is written and signed off" to "Lauren can retrieve": **~4-6 hours of my work**, assuming the playbook is well-structured markdown. I'd want the playbook to be final before I ingest it — re-ingesting after edits isn't painful but it's wasteful.

**The actual bottleneck is W2-4, not my pipeline.** If Nathan has the playbook done by end of week 2, I can have ingestion done within the same day and Lauren v1 can start week 3 on schedule. There's no technical blocker on my side that stretches the timeline — the content is the dependency.

**One thing the gate is missing:** there's no schema or code yet for Lauren's *reply generation* — the thing that takes an inbound homeowner SMS, retrieves relevant playbook chunks, and generates a response for human review before sending. That's a separate build from the ingestion pipeline. Budget another 4-6 hours for that, after ingestion is done. Combined: ~a day of work total before Lauren v1 is live. That fits in week 3 if the playbook lands in week 2.

---

## 3. On skipping Ohio-Intel, agent-per-lead, Mac-Mini-as-agent-platform, GHL decommission

**I agree with all four skips.** Here's my specific reasoning on each:

**Agent-per-lead:** Wrong abstraction for week 1. Managing concurrent stateful agents (one per lead) at 5 leads/week adds coordination overhead that doesn't pay off until we're running 50+ leads/week in parallel. Template cadence with pg_cron covers identical outcomes at 10% of the complexity. Re-evaluate at week 6 when we have volume.

**Ohio-Intel migration:** 6-month project correctly identified. Not touching it.

**Mac-Mini-as-agent-platform:** The Mac Mini should do exactly one job — sync iMessages. Consumer hardware that can sleep, lose power, or get a macOS update at any time is not a reliable agent runtime. All scheduled/triggered workloads belong in Supabase Edge Functions + pg_cron. Hard agree.

**GHL decommission:** Keep it running in parallel until the funnel has 4 weeks of real data. Decommissioning it now is risk with no benefit — it's already not costing us meaningful dev time.

**One thing on the skip list that's already done:** "iMessage group-send from DCC" is listed as a deferred Justin item. It shipped in the multi-contact SMS PR (#7). Group chats where all participants are DCC contacts route to the correct deal, render with names and reaction pills. You can remove it from the skip list.

---

## 4. Architecture: Edge Functions + triggers → one gap that will bite W1-2

The plan says "Supabase Edge Functions for scheduled/persistent workflows." Mostly correct, but there's a gap in how W1-2 is implemented that needs to be explicit before DCC Claude codes it up.

**The gap:** Postgres triggers cannot directly call Edge Functions (HTTP). A trigger fires within the transaction context — you can't make an outbound HTTP call from PL/pgSQL without the `pg_net` extension, which works but is asynchronous and has nuances (no guarantee of retry on failure, no backpressure).

**W1-2 implementation options — rank ordered:**

1. **pg_cron + pg_net (recommended):** A `pg_cron` job runs every 60 seconds. It finds deals where `lead_tier='A'` AND `sales_stage='new'` AND `meta->>'homeownerPhone' IS NOT NULL` AND no intro SMS has been sent. For each match, it calls the `send-sms` Edge Function via `pg_net.http_post`, then flips `sales_stage → 'texted'` and logs activity. This is reliable, retryable, observable, and doesn't block any transaction. `pg_cron` is already available in Supabase.

2. **Postgres trigger + pg_net (works but fragile):** Same effect but triggered immediately on insert/update. Faster (sub-second) but if `pg_net` fails silently (e.g., Edge Function returns 500), there's no retry mechanism built in. The transaction commits regardless.

3. **Realtime subscription in a persistent Edge Function (don't do this):** Edge Functions spin up per-request, not persistently. This doesn't work without an external orchestrator keeping one alive.

**For W2-1 (Day 3 + Day 7 follow-up tasks):** The plan's approach of inserting task rows (not scheduling SMS sends directly) is exactly right. `pg_cron` looks for tasks due today whose parent deal's `sales_stage = 'texted'`, surfaces them in the Needs Action view. Nathan taps one button. No direct scheduling required. ✅

**For W2-2 (reply-detection pings Nathan):** Trigger on `messages_outbound` INSERT where `direction='inbound'` — again needs `pg_net` to fire the ping SMS. Same recommendation: use `pg_cron` polling every 60 seconds for new inbound messages that haven't triggered a notification yet, rather than a direct trigger-to-HTTP call.

**Nothing in weeks 1-2 requires Inngest, Trigger.dev, Claude Agent SDK, or long-running Python.** pg_cron + pg_net handles everything. The Mac Mini stays iMessage-bridge-only. This is the right call.

---

## Summary table

| Item | My verdict | Action needed |
|---|---|---|
| W1-3 Twilio upgrade | ✅ correct, but incomplete | Nathan submits A2P 10DLC brand + campaign registration **day 1** alongside billing upgrade |
| W1-4 bridge launchctl | ✅ 5 min job | Confirm Nathan is logged into iMessage on Mac Mini first |
| Lauren ingestion pipeline | ⚠️ doesn't exist yet | ~4-6h to build once playbook is written; Lauren reply generation is another 4-6h. Total ~1 day. Not on critical path if playbook lands end of week 2. |
| Skip agent-per-lead | ✅ agree | — |
| Skip Ohio-Intel | ✅ agree | — |
| Skip Mac-Mini-as-agent-platform | ✅ agree | — |
| Skip GHL decommission | ✅ agree | — |
| W1-2 auto-SMS trigger | ⚠️ implementation gap | Use pg_cron + pg_net polling, not a direct Postgres trigger; DCC Claude should know this before coding |
| W2-1 cadence task queuing | ✅ correct approach | Insert task rows, not scheduled SMS sends — good |
| W2-2 reply detection | ⚠️ same gap as W1-2 | pg_cron polling for inbound messages, not direct trigger → HTTP |
| iMessage group-send skip | ✅ moot | Already shipped in PR #7, remove from skip list |

Greenlight from me. The A2P 10DLC thing is the only real gotcha — if that registration isn't in flight on day 1, W1-2 ships on time but messages don't actually arrive. Everything else is buildable as written with the pg_cron clarification.
