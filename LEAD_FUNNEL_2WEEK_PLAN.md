# Lead Funnel — 2-Week Ruthless Plan

**Drafted:** 2026-04-23
**Owner of this plan:** Nathan
**Goal:** Smallest working system that handles 1 A-lead/week end-to-end reliably,
with the data to know what to automate next.

---

## Goal state · end of week 2

A new A-tier lead that Castle scores and hands to DCC goes through this without
Nathan clicking anything until a reply lands:

1. Castle → `submit-lead` → DCC deal with `lead_tier='A'`
2. DCC auto-fires Tier-A intro SMS (templated, not AI) to homeowner
3. `sales_stage` flips `new → texted`
4. Day 3: follow-up task auto-queues with template pre-loaded; one tap to send
5. Day 7: final touch auto-queues
6. Any inbound reply → Nathan's iPhone gets a ping SMS + cadence pauses
7. Reply is handled **manually by Nathan for now** (Lauren isn't ready yet)
8. Every event logs to the deal's Comms thread and the Reports pipeline updates

**Success criterion:** 5 real A-leads complete steps 1–6 without Nathan opening
DCC before the reply. That's the bar.

---

## What we explicitly skip · weeks 1–2

None of these happen. No exceptions.

- **Lauren conversational intake** — deferred to week 3-4 once baseline data exists
- **Ohio-Intel migration** — 6-month project. Not now.
- **Agent-per-lead infrastructure** — premature; templated cadence covers the use case
- **Mac-Mini-as-agent-platform** — iMessage bridge only, nothing else
- **Multi-county scraper expansion** — Castle v1 footprint is what we work with
- **Twilio Voice webhook** — nice-to-have, doesn't block SMS-first outreach
- **iMessage group-send from DCC** — Justin-side bridge work, deferred
- **GHL decommission** — stays parallel until the funnel proves out
- **Outbound call origination from DCC** — deferred
- **"Daily AI optimization" Claude-as-consultant** — noise, not useful at this stage
- **Tracking GPT/Claude release rumors** — 30 min/week max, not a strategy
- **Send-as `nathan@refundlocators.com` from Gmail** — tabled, not blocking

If any of these come up in a session as "we should also do X," push back and
point at this list.

---

## Week 1 · tickets

Goal: **an A-lead can enter the funnel without Nathan clicking anything.**

### W1-1 · Auto-generate `refundlocators_token` on deal insert
- **Owner:** DCC Claude (me)
- **Effort:** 30 min
- **What:** Postgres trigger on `public.deals` insert → stamp a UUID into
  `refundlocators_token` if null. Intro-SMS templates stop showing `[token-pending]`.
- **Success:** every new deal has a non-null `refundlocators_token`.
- **Non-goal:** Castle-side token generation (Castle catches up when it's ready;
  this unblocks DCC).

### W1-2 · Auto-SMS on new A-tier lead
- **Owner:** DCC Claude (me)
- **Effort:** 2 hours
- **What:** Trigger on `deals` insert OR update where `lead_tier='A'` AND
  `meta->>'homeownerPhone' IS NOT NULL`. Calls `send-sms` with the Tier-A template
  from `sms_templates`. Flips `sales_stage` → `texted`. Logs a `log_deal_activity`
  entry "🤖 Auto-sent Tier A intro SMS."
- **Guardrails:**
  - Runs ONCE per deal (check for existing `messages_outbound` row with `body like
    'Hi %...RefundLocators%'`)
  - Skips if `meta->>'homeownerPhone'` is a test/placeholder number
  - Skips if deal has `sales_stage != 'new'` (already processed)
- **Success:** 3 test deals trigger, 3 SMS go out, 0 duplicates.
- **Non-goal:** B-tier, C-tier, 30DTS auto-SMS (expand after A proves out).

### W1-3 · Upgrade Twilio out of trial mode
- **Owner:** Nathan (5 min admin) · Justin if billing info needed
- **Effort:** 10 min
- **What:** Twilio dashboard → Billing → add credit card → upgrade to pay-as-you-go.
- **Blocker if not done:** auto-SMS will fail for any unverified recipient
  number (every real lead). This is the biggest non-code blocker.
- **Success:** `send-sms` succeeds for an unverified test number.

### W1-4 · iMessage bridge running on Mac Mini
- **Owner:** Justin
- **Effort:** 5 min `launchctl load`
- **What:** Edit the 3 paths in `mac-bridge/com.refundlocators.bridge.plist`,
  `cp` to `~/Library/LaunchAgents/`, `launchctl load` + `start`. Confirm via
  `tail -f /tmp/dcc-bridge.log`.
- **Success:** Nathan sends an iMessage from his iPhone to a contact; the
  message appears in DCC's Comms thread within 10 seconds.
- **Non-goal:** group-chat handling (that's the separate bridge spec I wrote).

### W1-5 · Hand-run 5 current high-equity leads through the funnel manually
- **Owner:** Nathan + Eric
- **Effort:** 1-2 hours spread over the week
- **What:** Take the 5 highest-equity leads you have today ($273k, $150k, $98k,
  etc.) and walk each through the full sequence by hand. Log reply timing,
  objections, questions, closes that worked, closes that didn't.
- **Deliverable:** a 1-page doc of real conversation patterns. This is what
  Lauren's playbook gets built from in week 2.
- **Success:** at least 2 of the 5 respond. Whatever the result, you have data.

---

## Week 2 · tickets

Goal: **every reply wakes Nathan up; everything else runs itself.**

### W2-1 · Cadence v1 (Day 3 + Day 7 follow-up tasks)
- **Owner:** DCC Claude (me)
- **Effort:** 3 hours
- **What:** When the intro SMS sends, queue two `tasks` rows:
  - Day 3: "💬 Day 3 follow-up — Casey Jennings" with the Tier-A-day-3
    template body pre-loaded
  - Day 7: "💬 Day 7 final touch — Casey Jennings" same
- **Templates:** 2 new rows in `sms_templates` (Tier-A day-3, Tier-A day-7).
  Nathan writes the copy.
- **One-tap send:** task detail has "Send this message" button that fires
  `send-sms` with the pre-loaded body.
- **Non-goal:** AI-generated follow-ups. Template + one click.

### W2-2 · Reply-detection pauses cadence + pings Nathan
- **Owner:** DCC Claude (me)
- **Effort:** 1 hour
- **What:** Trigger on `messages_outbound` INSERT where `direction='inbound'`
  AND sender phone matches a deal's homeowner. Side-effects:
  - Mark queued Day 3 / Day 7 follow-up tasks `done` with note "auto-completed
    by reply on {date}"
  - Flip `sales_stage` → `responded`
  - Send a ping SMS to Nathan's iPhone: "💬 Casey Jennings replied: '...first 80
    chars...'"
- **Success:** test reply from a verified number → task auto-closes, Nathan's
  phone buzzes.

### W2-3 · Needs Action dashboard on Today view
- **Owner:** DCC Claude (me)
- **Effort:** 2 hours
- **What:** New card at the top of Today view showing three counts:
  - 🔥 New A leads awaiting first text (shouldn't exist once W1-2 ships — alerts
    if the auto-SMS trigger broke)
  - 💬 Follow-ups due today
  - 😴 Stale — 7+ days no reply, consider drop-out
- **One click per line:** jump to filtered deal list, composer opens with the
  template ready.

### W2-4 · Lauren playbook writeup
- **Owner:** Nathan (+ Eric's input)
- **Effort:** 4 hours of writing
- **Deliverable:** `LAUREN_PLAYBOOK.md` in DCC repo containing:
  - 10 FAQs homeowners ask, with exact answer text
  - 5 objections ("I don't trust AI", "25% is too much", "my cousin said
    don't sign", etc.) with response scripts
  - 3 closes for different signals (warm, lukewarm, needs-a-call)
  - Hard "NEVER say" list (anything about timing, pricing, attorney identity,
    medical / legal advice)
- **Why now:** if you can't write it, Lauren can't execute it. This work
  is the actual blocker to Lauren v1, not code.

### W2-5 · Run 15 A-leads through the system
- **Owner:** Nathan + Eric
- **Effort:** ongoing
- **What:** Let Castle (or manual import) push 15 A-tier leads in. Watch them
  go through W1-2 auto-SMS, track reply rate, track what questions come in.
- **Success:** we have 15 × (lead → reply / no reply) data points.

---

## Metrics to baseline from Day 1

Add these to the Reports view (I can wire them this week, ~30 min each).

| Metric | Target | How measured |
|---|---|---|
| Time: lead ingested → first SMS | < 60 sec | `MIN(messages_outbound.created_at) - deals.created_at` where body matches intro template |
| Reply rate by tier (A/B/C) | baseline | `count(inbound msgs) / count(deals) group by tier` |
| Median time to first reply | baseline | `first inbound - first outbound` |
| Drop-off point | baseline | at which `sales_stage` do deals go stale > 14d? |
| Funnel conversion | baseline | `new → texted → responded → signed → filed → paid-out` per tier |
| Per-lead acquisition cost | baseline | Twilio cost + Claude cost + Castle compute per closed lead |

If we don't baseline these, we can't tell whether Lauren improves anything.

---

## Gate to week 3 · Lauren ships

None of these can be skipped before Lauren v1 starts:

- [ ] 20+ A-leads have completed W1-2 auto-SMS cycle
- [ ] Reply rate baseline established (median, variance)
- [ ] W2-4 `LAUREN_PLAYBOOK.md` is written and signed off by Nathan
- [ ] Justin's `lauren_knowledge` pgvector table has the playbook chunked + embedded
- [ ] Twilio is out of trial mode (W1-3)
- [ ] iMessage bridge has been running for 7 days without crashing (W1-4)
- [ ] DCC has no regression bug open in Comms or the send-sms path
- [ ] First 50 Lauren replies will go through a human-review queue before sending

If ANY of these aren't true, delay Lauren. The cost of a hallucinating AI
saying the wrong thing to a foreclosed homeowner is worse than a week of delay.

---

## Ownership split

| Track | Owner | Not owned by |
|---|---|---|
| DCC triggers / cadence / dashboard | me (DCC Claude) | Justin |
| Twilio + iMessage bridge | Justin | me |
| Castle scoring + token population | Castle Claude session | me, Justin |
| Lauren playbook (content) | Nathan | anyone else |
| Lauren pgvector ingestion | Justin | me |
| Lead hand-running + baseline tracking | Nathan + Eric | AI |
| This plan | Nathan | everyone else — it's his call if we pivot |

Single-threaded owner per track. No "we'll figure it out together" tickets.

---

## If we need to re-scope

If week 1 slips, cut in this order:
1. Cut W1-5 (hand-run 5 leads) — keep the tech work
2. Cut W2-3 (Needs Action dashboard) — nice-to-have
3. Cut W2-5 (15 more leads) to W3

Do NOT cut: W1-1, W1-2, W1-3, W2-1, W2-2, W2-4.

Those are the spine.

---

*This is the 2-week plan. Everything else is week 3+.*
