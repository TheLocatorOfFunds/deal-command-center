# RefundLocators.com — Vision Brief

**Audience**: Nathan, Justin, and any Claude Code session picking up work on refundlocators.com.
**Purpose**: Codify the "think like Elon Musk" strategic direction — what we are building, why it is category-defining, and how DCC stays the invisible brain behind it.
**Relationship to other docs**:
- `REFUNDLOCATORS_CONTEXT.md` — tactical context (stack, schema, MVP scope)
- `HANDOFF_FROM_DCC_TO_REFUNDLOCATORS.md` — integration contract between refundlocators and DCC
- **This doc** — the "why" and the "what if" that the other two serve

---

## 1. The one-sentence version

> **RefundLocators.com is an AI-native, self-serve surplus fund recovery experience that makes the cold-call playbook obsolete — and turns the client experience itself into our distribution channel.**

Incumbents in this industry run a sales-floor model: buy a list, cold-call post-foreclosure homeowners, out-dial the competition, convince one out of 500 to sign an agreement. We are building the opposite: homeowners find *us*, get their exact dollar amount instantly, chat with an AI that knows Ohio law cold, sign an agreement by SMS in under 15 minutes, and leave the experience feeling respected instead of hunted.

DCC is the operational spine. RefundLocators is the consumer-facing surface.

---

## 2. Why the industry is broken

Three structural flaws, all of which we can exploit:

1. **The cold-call playbook is hostile.** Post-foreclosure homeowners have just lost their house. The moment the sale hammer drops, 30+ recovery firms start dialing. It feels predatory. It is predatory. Even when the service is legitimate, the experience is not.
2. **Fees are hidden and negotiated opaquely.** Most recovery firms obscure their cut (20–40%) until contract stage. Homeowners don't know if they're being overcharged until after they sign.
3. **There is no "self-serve" path.** No one can search their own name, see their own surplus amount, and choose to engage — because every incumbent profits from asymmetric information. If a homeowner could see the money themselves, they wouldn't need the middleman. So incumbents hide the data.

If we invert all three — warm inbound, radical fee transparency, free lookup tool — we don't compete on the same axis. We change the axis.

---

## 3. The reframe

**From**: Outbound sales company that happens to use the internet.
**To**: An AI-first consumer product that happens to recover surplus funds.

The difference is tangible:
- A sales company measures dials, conversions, and cost-per-lead.
- A product measures engagement, retention, referrals, and NPS.

Every decision flows from that reframe. We don't hire more closers. We improve the AI's knowledge base, the signup friction, the post-sign experience. Each improvement compounds — a better AI today is a better AI next year, forever. A better closer plateaus.

---

## 4. The cinematic user journey ("Lisa")

Imagine Lisa, whose foreclosed home sold at auction in Hamilton County six weeks ago. She is broke, ashamed, and getting 40 spam calls a day. She has stopped answering her phone. She sees a Google ad: *"Your foreclosure sale may have left money behind. Search your address to see — free, no calls."*

1. **Land on refundlocators.com.** Clean, cream-and-navy. No stock photos of happy families. One sentence: "Enter your address — see if money is owed back to you."
2. **Enter address.** AI pulls the county docket in real time. Finds her case. Pulls Street View imagery of her former home.
3. **Sees her house.** Full width. No words yet. Just the house she lost. Ten seconds of silence, but the page is doing work.
4. **AI reveals the amount.** "We found your case. You are owed **$41,287.42** from the sale of 1247 Elm Street."
5. **AI is honest that DIY is an option.** "You can absolutely file this claim yourself at the Hamilton County Court of Common Pleas — it's not a secret. The reason most people have us do it is that there are a few procedural steps where Ohio trips people up and a filed claim on the wrong form gets kicked back. If you want the DIY instructions, I'd love to walk you through them on a quick call so they make sense — it's the part that's hard to text." (The AI does NOT paste the form, filing fee, or procedural steps into the chat. The walk-through happens on a call. DIY exists; the blueprint is not handed over in a text thread.)
6. **AI offers the service transparently.** "Or we can file it for you. Our fee is **30% ($12,386.23)**. You would receive **$28,901.19**. We can have a DocuSign agreement to you by text in 60 seconds."
7. **Lisa asks the AI a question.** The AI answers. It knows ORC §2329. It knows the Hamilton County local rule on cashier's-check disbursement. It knows the last 40 cases by case number.
8. **She chats for 12 minutes.** The AI answers every question. It gently asks, *"Were you the only person on the deed when the property sold? Are you still in the house? Are you okay? Do you have food?"* Not as a qualification funnel — as a human being noticing another human being.
9. **She says "send it."** SMS arrives. DocuSign prefilled. Signed in 10 seconds.
10. **Instant confirmation.** "We got it. Nathan will record a 60-second welcome video for you in the next 48 hours. Meanwhile, here's your personal case dashboard."
11. **72 hours later.** She gets a text: *"Filed with Hamilton County clerk today. Case 2026-CV-0041 assigned. Expected hearing date: May 21."*
12. **Payout day.** The check clears. She screenshots her dashboard and posts it to Facebook unprompted. Three friends message her asking for the link.

That post is worth more than any Google ad. The product IS the marketing.

---

## 5. The 10 category-killer moves

These are the design choices that make RefundLocators uncopyable by incumbents. Each one is a deliberate 10x UX improvement over the status quo.

### 5.1 Exact dollar amount upfront, not "you may have money"
Every competitor says "you MAY have surplus funds." We say "You have **$41,287.42**." The specificity is the differentiator. It requires a real data pipeline. Incumbents can't copy it without rebuilding their backend.

### 5.2 Street View as the first image
The homeowner sees their former house — full-bleed, silent, immediate. It's emotional. It's proof we did the work. No incumbent does this because their sales model doesn't need to.

### 5.3 The AI is honest that DIY exists — without handing over the blueprint
Every incumbent hides that the homeowner could file the claim themselves. We don't. **The AI confirms the DIY path is real and legal, and offers to walk through it on a phone call.** What the AI does NOT do: paste the form, the filing fee schedule, and the procedural instructions into a text thread.

The reason is practical, not deceptive. DIY is real but non-trivial. Ohio has procedural landmines by county — correct caption, proof of service, affidavit format, cashier's-check disbursement rules — that cause self-filed claims to get kicked back. A 10-minute phone walk-through saves people weeks. We tell homeowners honestly that they *can* file it themselves, and we offer to walk them through it on a call whether or not they ultimately hire us.

This is still the single biggest trust signal we can send. The homeowner thinks: "They told me I don't have to hire them, and they're still offering to help me do it myself. So if I hire them anyway, it's because I genuinely want to." That is the moment the relationship flips from "sold to" → "chose us."

### 5.4 Fee transparency to the penny
Not "our competitive rates." **"Our fee is 30%. On your $41,287.42, that is $12,386.23. You keep $28,901.19."** Written on the landing page. Written in the chat. Written in the DocuSign. If we ever negotiate, it's documented in writing before signing.

### 5.5 AI trained on Ohio law, ORC, county rules, and case history
This is the data moat. A general LLM can't do this. Even a competitor with a great closer can't do this. Our AI is useful because it knows more than any human in the industry about Ohio surplus recovery procedure.

### 5.6 No phone calls unless the homeowner asks
Default is text/chat. A "call me" button exists — Nathan's direct line, tap-to-dial. But we don't dial out. **Inversion of the industry default is the product.**

### 5.7 Two intake paths, both frictionless

**Path 1 — GHL leads responding to outreach.**
These are people already in our GoHighLevel database from Justin's prior work — post-foreclosure homeowners we've texted, mailed, or pulled from county filings. When they reply to a drip or click a link, the AI already has their name, address, county, and case number. Intake is a conversational confirmation only: *"I pulled your record — is 1247 Elm St in Hamilton County still the right property?"* One reply and we're in the legal/empathy flow.

**Path 2 — Site visitors doing a fresh search.**
Someone lands organically, via ads, or via a referral. The site asks for six fields:

1. **Name**
2. **Phone**
3. **Email**
4. **Address** of the foreclosed property
5. **County**
6. **Case number** *(if they have it — optional)*

On submit the site shows an immediate confirmation: *"Got your request. We're working on it now. Check your phone in the next 2 minutes."* Within 60–120 seconds the AI texts back with either the exact surplus amount or a note that it is pulling additional records and will confirm shortly.

Either path lands in the same place: the AI knows who you are, what you're owed, and walks you through options. DocuSign agreement is 10 seconds from "send it" to "signed."

### 5.8 **A post-contract customer experience that turns clients into evangelists** *(this is the quiet moat)*

This is the most important section in this doc. The industry treats the signed contract as the finish line. We treat it as the starting line.

After signing, the client immediately gets:

- **A personal case dashboard** at `refundlocators.com/case/[token]` — case number, filing status, expected timeline, estimated payout date, every document stored, every update logged. Magic-link secured. Bookmarked and opened dozens of times over the 3–6 month case.
- **A 60-second personalized welcome video from Nathan within 48 hours.** "Hi Lisa, I'm Nathan. I saw your case come in Tuesday. I wanted to say hello directly, answer any questions, and let you know we're filing on Thursday. You've got my cell — use it." Recorded on an iPhone. Not polished. Intentionally not polished. The humanity is the point.
- **Weekly AI status texts.** Every Friday morning, the AI sends a short status update. "Filed Monday. Clerk assigned case number Wednesday. Hearing set for May 21. Nothing you need to do. Questions? Text back."
- **Always-open chat.** The same AI that closed the deal stays on for the full case. Client can ask anything, anytime. Responses are instant. If the question is legal/complex, it escalates to Nathan and the AI tells the client *"Nathan will get back to you within 4 business hours."*
- **Payout-day celebration.** When funds clear, the AI sends a text with a single image — the Street View of their old house with the caption *"Today you got $28,901.19 back from this home. You did it."* Designed to be screenshotted and shared.
- **Anonymous success-story invitation.** 7 days after payout: "Would you be open to us sharing your story anonymously? Just the county, the amount, and the timeline — no names. It helps the next homeowner trust us enough to search." Opt-in. Feeds the public transparency counter (see 5.9).
- **The iPad, awarded on the signed engagement agreement** (not a sweepstakes, not conditional on payout). Arrives within a week of signing. Intentionally reframes the gift from "incentive to convert" → "thank you for trusting us." Becomes part of the story — every iPad recipient tells 3–5 people why they got one.
- **Post-recovery partnerships.** Once funds clear, optional introductions the client can accept or ignore: a vetted CFP for rebuilding credit / managing the lump sum, an insurance advisor for their next housing situation, a home re-entry resource list if they want to buy again. No kickbacks tied to signed agreements — we pick partners on merit and disclose the relationship. The goal is for them to feel this was the most helpful financial event of their decade, not just a transaction.

The logic: a signed contract earns us one fee. A screenshot-worthy post-payout moment earns us their next 5 friends in the same situation. **The post-sign experience is the referral engine.**

### 5.9 Public transparency counter
A live counter on the homepage: **"$X,XXX,XXX returned to Ohio homeowners. X,XXX cases recovered. Y% average fee."**
Updated daily from DCC. Anonymized. Builds the kind of credibility that no ad buy can match. Over 3 years it becomes the defining stat of the industry.

### 5.10 Voice-note option
Some homeowners — especially older — hate typing. An "ask by voice note" button records 30 seconds, ElevenLabs transcribes, Claude responds, ElevenLabs responds by voice in a warm human-sounding voice (disclosed as AI). For the homeowner who is overwhelmed, this is the most human thing a web app can do.

---

## 6. The AI engine (technical sketch)

The AI is the product. It deserves more architectural attention than anything else.

### 6.1 Models
- **Claude Sonnet** — conversation brain. Answers questions, runs the empathy flow, decides when to escalate.
- **Claude Haiku** — classifier. Routes messages (FAQ vs legal-question vs escalation vs STOP). Fast, cheap, always-on.

### 6.2 Retrieval
- **Supabase pgvector** indexed over:
  - Full Ohio Revised Code §2329 (surplus distribution)
  - Ohio Civil Rules (procedure)
  - Each target county's local rules (starting Hamilton, Franklin, Cuyahoga)
  - Our internal case history (anonymized, pulled nightly from DCC)
  - FAQ corpus curated by Nathan and refined weekly

### 6.3 Tools (function calls the AI can invoke)
- `search_surplus_records(address | name)` — hit our county index
- `lookup_docket(case_number)` — live docket fetch
- `calculate_payout(amount, fee_pct)` — deterministic math
- `send_agreement(lead_id)` — DocuSign via GHL webhook
- `escalate_to_human(reason, urgency)` — page Nathan, optionally book a call
- `search_knowledge_base(query)` — RAG over legal corpus
- `store_empathy_signal(lead_id, signal)` — log wellbeing data point for follow-up

### 6.4 Guardrails
- **No legal advice.** The AI can explain procedure, cite statute, share filing instructions. It does not say "you should" or "I recommend" on legal questions. When pressed, it escalates.
- **AI disclosure.** First message in every conversation: *"I'm RefundLocators' AI assistant. A real human (Nathan) can jump in anytime — just ask."* If the user asks "are you a bot?" answer yes immediately.
- **Bankruptcy — qualify, tag, nurture; don't slam the door.** When the homeowner mentions bankruptcy, the AI does NOT immediately shut down the conversation. Instead it gathers four data points conversationally (see §6.4.1), tags the GHL contact with the appropriate `BK-*` tag, and routes active-stay homeowners into a monthly BK nurture flow instead of weekly cadence. Aggressive outreach still pauses during an active stay; the conversation stays warm and useful. Nathan is notified on the tag so he's aware. Full script in §6.4.1.
- **Self-harm protocols.** If the user expresses suicidal ideation or extreme distress, AI stops the business conversation entirely and provides crisis line information. Escalates to Nathan for a human follow-up call (never a text).
- **Cross-brand suppression.** Anyone who says STOP is globally suppressed across refundlocators, fundlocators, and defenderha immediately.

### 6.4.1 Bankruptcy conversation flow

When the homeowner mentions bankruptcy (either unprompted — "I filed BK last year" — or in response to a question), the AI does NOT go silent. It asks these four questions in order, conversationally, one at a time, letting the homeowner's answer guide the next ask:

1. *"Appreciate you mentioning that — did you actually file, or were you considering it?"*
2. *(If filed)* *"Was it a Chapter 7 or a Chapter 13?"*
   *(Ch 7 = liquidation — trustee may have had a claim on the surplus. Ch 13 = repayment plan — surplus may have been part of the plan distribution. Both change how we approach the case.)*
3. *"When did you file — roughly what month and year?"*
   *(Recency matters. A filing from last month vs. three years ago is a different conversation.)*
4. *"Has it been discharged or dismissed yet, or is it still open?"*
   *(Discharge = case closed, debtor got their fresh start. Dismissed = case thrown out. Still open = active automatic stay in force.)*

Based on the answers, the AI routes the homeowner into one of four buckets via GHL tags. Nathan is notified on every BK tag so he has awareness of the pipeline.

| Situation | GHL tag | Outreach cadence | What the AI says |
|---|---|---|---|
| Filed, still open (active stay) | `BK-active` | **Monthly nurture only** — no weekly drip, no aggressive cadence | *"Got it. While your case is open, we don't want to step on your bankruptcy attorney's work. We'll check in once a month — when it's discharged we can pick up the surplus conversation. Hang in there."* |
| Filed, discharged or dismissed | `BK-cleared` | Normal flow — surplus recovery is typically the homeowner's again post-discharge | *"Good — since it's behind you, the surplus piece is usually yours again to recover. I'd still mention this to your attorney if you're in touch. Do you want to walk through what we found?"* |
| Considered but didn't file | `BK-considered` | Normal flow, flagged as financially stressed — extra care on fee framing | *"Understood. That's a tough spot. Let me walk you through what the surplus recovery looks like — there's no cost to you upfront either way."* |
| Homeowner refused to answer | `BK-unknown` | Soft nurture only — no pressure | *"No problem, you don't have to tell me anything you don't want to. We can pick it up whenever works for you."* |

The monthly BK nurture flow (for `BK-active`) is a single warm check-in per month with one of these variants, rotated:
- *"Hey [name], just checking in. How's everything going with your case? We're here whenever the time is right."*
- *"Thinking of you this month. If anything changes with your bankruptcy status, let me know and we'll pick up where we left off."*
- *"Quick check-in — no pressure, no sales talk. Just wanted to make sure you're doing okay."*

**This replaces the older "pause and attorney-refer" policy.** Pausing aggressive outreach during active stay is still the rule. The difference is that the AI stays a warm, monthly presence instead of going silent. Silence signals "you lost your chance." Warmth signals "we'll be here when the time is right" — which is the brand promise.

### 6.5 The empathy question set *(post-submission, pre-legal-discussion)*

After the homeowner has either submitted the 6-field search OR confirmed the GHL-prefilled intake, the AI pivots to a short empathy/context conversation BEFORE the payout math. These questions do two things at once: they gather data we need to file correctly, AND they prove the AI is trained to see humans first.

Verbatim questions, in order:

1. *"Quick question for the paperwork — were you the only person on the deed when the property sold at auction, or were there others on title with you?"*
   *(Answer drives claim procedure. Multiple claimants = multiple signatures, different filing.)*

2. *"Are you still living in the house, or have you already moved out?"*
   *(Answer affects urgency and cadence. Still in the house → redemption timing matters, different legal posture.)*

3. *"How are you doing? I mean that — this is a hard thing to go through."*
   *(Open-ended. No metric attached. The answer is logged only so Nathan can reference it on the welcome video.)*

4. *"Do you have food and a safe place to sleep tonight? If not, tell me — I'd rather help with that first and come back to the paperwork later."*
   *(Non-negotiable. If the answer is no, the AI does not continue the sales flow. It connects the homeowner to local resources and flags Nathan for a human call within 2 hours. Dignity first, revenue second. Every time.)*

5. *"I'm really sorry this happened to you. Whatever comes next, we'll walk through it one step at a time."*
   *(Not a question. A statement. Logged as part of the transcript. Sent whether or not the homeowner signs.)*

These are the questions a 20-year-industry sales floor will never be allowed to ask, because they don't pencil on a call-center scorecard. We can ask them because our AI has infinite patience and our business model doesn't depend on closing the next call in 4 minutes.

The data captured here populates `deal.meta.refundlocators.empathy_signals` in DCC, informs Nathan's welcome video, and (crucially) becomes the anonymized training data that makes our AI warmer than every competitor's AI, forever.

---

## 7. The data moat

Every conversation, every case, every county filing, every outcome — captured, anonymized, indexed, and fed back into the AI.

- Year 1: AI knows Ohio law.
- Year 2: AI knows which Hamilton County magistrates grant continuances and which don't.
- Year 3: AI can predict recovery probability and timeline from case intake alone with better accuracy than any attorney in the state.

This is not buildable by a competitor starting from zero. The moat compounds. The more homeowners we help, the better we help the next one. Incumbents running a sales floor don't generate this data — they generate dialer logs.

---

## 8. The surplus records index

Before the AI can work, we need the data.

### Phase 1: Three counties
Hamilton, Franklin, Cuyahoga — the three largest Ohio counties by population and foreclosure volume. Start here.

### Daily scraping
Cloudflare Workers cron daily against the clerk's online dockets. Parse the sale confirmation entries. Compute surplus. Write to `rfl.surplus_records` (Supabase, separate schema from DCC's `public`). Index by address, name, case number.

### 5-year backfill
On first deployment, scrape back 5 years. This gives us the base of named homeowners with provable surplus. Most are past the statute but still legally claimable. Each one is a potential warm lead.

### IDI / BatchSkipTracing enrichment
For every surplus record, enrich with current phone/email/address. Opt-in only for outbound; the full dataset is used to match when someone searches the site.

### Open-source the free lookup tool
Publish a standalone `search.refundlocators.com` that anyone — including competitors and journalists — can use for free, forever. Two strategic effects:
1. Journalists cover it. Local news picks up stories of homeowners finding $40K they didn't know about.
2. Competitors have to match it or look opaque. They can't match it without exposing their own margin.

The free tool is a Trojan horse. We give away the data. We charge for the filing service. Incumbents would rather die than give away the data, which is why they can't copy this.

---

## 9. DCC as the invisible backbone

DCC is the operational brain that homeowners never see. Every refundlocators moment has a corresponding DCC action:

| Moment on refundlocators | DCC action |
|---|---|
| Homeowner submits 6-field search | `activity` row created: "anonymous search: {address}" — no deal yet |
| Search matches a surplus record | AI texts back with amount within 60–120 sec |
| Homeowner replies to AI text / opens chat | Still no deal; `meta` tracked in bot DB until qualified |
| Empathy questions answered | Logged to bot DB; pushed to `deal.meta.refundlocators.empathy_signals` on deal creation |
| DocuSign envelope signed | **Deal created in DCC.** `type='surplus'`, `status='signed'`, `lead_source='refundlocators-sms'` or `-web`, signed PDF uploaded to `deal-docs` bucket |
| Welcome video recorded by Nathan | Link stored in `deal.meta.welcome_video_url`; activity logged |
| Weekly AI status text sent | Activity row |
| Case filed with county | `status='filed'`; activity row |
| Funds received | `status='recovered'`; `actual_net` populated; `closed_at` set |
| Payout celebration text sent | Activity row |
| Anonymous success story opt-in | `deal.meta.public_story_consent=true`; flows to homepage counter |

**The rule**: anything that is a business record, a legal artifact, or a revenue-affecting event lives in DCC. Anything that is ephemeral chat state, rate-limit counters, or pre-qualification data lives in the bot infrastructure (Python + SQLite, per the Cowork chat). The handoff is the DocuSign signature.

Full integration details: `HANDOFF_FROM_DCC_TO_REFUNDLOCATORS.md`.

---

## 10. Phased build

### Phase 1 — MVP landing + search (4–6 weeks)
- Cloudflare Pages deploy (already live)
- Surplus records index: Hamilton County, 5-year backfill
- 6-field intake form + confirmation flow
- AI chat (Sonnet + basic Ohio RAG)
- SMS outbound via Twilio (post-10DLC approval)
- Manual DocuSign send for first 10 signed clients
- DCC integration: deals created on signed webhook

### Phase 2 — SMS bot + empathy flow (6–12 weeks)
- Full Python bot (per Cowork chat scaffold) in production
- GHL integration: AI pulls prior lead data for returning contacts
- Empathy question set live
- Welcome-video pipeline (Nathan records, auto-texts link)
- Weekly status text cron

### Phase 3 — Post-sign customer experience (10–16 weeks)
- Personal case dashboards (magic-link auth, feeds from DCC)
- Payout-day celebration automation
- Success story opt-in + anonymized homepage counter
- iPad fulfillment workflow (Shopify or direct order integration)

### Phase 4 — The moat (12–20 weeks)
- Franklin + Cuyahoga counties live
- Public free-lookup tool at `search.refundlocators.com`
- RAG corpus expanded: ORC, civil rules, all 3 county local rules, case history
- Voice-note option (ElevenLabs in + out)

### Phase 5 — Multi-state (6 months+)
- Expand beyond Ohio only after the 3-county Ohio model is profitable, documented, and defensible. Each new state = new statute corpus + new county pipeline. Don't start until Ohio is a machine.

---

## 11. The 10 KPIs

What we measure. If a metric isn't on this list, we don't optimize for it.

1. **Search → Found rate** — % of searches that match a real surplus record (quality of data pipeline)
2. **Found → Chat rate** — % of homeowners who engage the AI after seeing their amount
3. **Chat → Signed rate** — % of chats that reach a signed DocuSign
4. **Signed → Funded rate** — % of signed cases that result in actual payout
5. **Time-to-fund** — median days from signed to check cleared
6. **Average payout to homeowner** — dollars after our fee (bigger the better; signals we're taking the larger cases, not gouging small ones)
7. **NPS** — post-payout survey
8. **Screenshot-shares** — count of homeowners who share dashboard/payout moments publicly (proxied via unique referral link clicks)
9. **Cost per signed** — total marketing + infra spend / number signed
10. **% no-human-contact** — percent of signed cases where the homeowner never spoke to a human before signing. **This is our uniqueness metric.** Every competitor's is 100% human-contact. Ours should trend toward 70%+ within 12 months.

---

## 12. Why we win (and why incumbents can't copy)

Even if a competitor read this doc word-for-word, they could not execute it. Here's why:

1. **They have sunk cost in sales teams.** Firing the floor means destroying their current revenue. They will defer until it's too late.
2. **Their margins depend on opacity.** The moment they publish fees on their homepage, average fee collapses across the industry. They will not do this voluntarily.
3. **They have no technical DNA.** Most incumbents are sales-led, not product-led. Building an AI with legal RAG, an SMS bot, a county scraper, and a client dashboard is outside their engineering capability.
4. **Their brand is tied to the dialer.** "We called you" is their identity. Inverting it is an existential threat to who they are, not just what they do.

The gap widens every month we compound. Data → better AI → better UX → more signups → more data.

---

## 13. The non-negotiable: honesty

Every single thing on this site, in the AI, in the dashboard, in the contract — passes the courtroom test: *"Would Nathan be comfortable if a plaintiff's attorney read this aloud to a jury of Ohio homeowners?"*

- Fees: disclosed in plain English, to the penny, before signing.
- AI: disclosed on first message, every time.
- DIY alternative: acknowledged proactively, in every conversation. Detailed procedural walk-through happens on a phone call, not in a text thread — because Ohio procedure is where people get kicked back, and a 10-minute call saves real time.
- Suppression: instant and cross-brand.
- Empathy flow: never used as a qualification trick. If someone says they don't have food, the sale stops, period.
- Gift program (iPad): tied to the signed agreement, not to outcomes, not to virality. No gotchas.
- Success stories: anonymized and opt-in only.
- Bankruptcy: qualified conversationally (filed? Ch 7 or 13? when? discharged?), tagged, and routed to a monthly nurture cadence during active stay. Never cut off, never pressured through, never ghosted.

This is not a constraint on the business. **This is the business.** Every category-killer move in section 5 depends on this being true. The moment we cheat, all ten moves collapse.

---

## 14. What to build next

If we only got 90 days to prove this thesis, the priority order is:

1. **Hamilton County surplus records index + 6-field search + text-back confirmation.** If we can't show someone their exact surplus amount within 2 minutes of submission, nothing else matters.
2. **AI chat with the empathy question set live.** Even without the full legal RAG, the empathy flow is the differentiator. Sonnet + a good system prompt gets 80% of the way.
3. **DocuSign → DCC handoff.** The moment a homeowner signs, a deal appears in DCC. Everything else is downstream of that.
4. **One Nathan welcome video.** Record the first one by hand. Prove the pattern. Automate it in Phase 2.

Nothing else in sections 5–11 matters until those four work end-to-end for one real homeowner.

---

## Changelog

- **2026-04-16** — Initial vision brief. Incorporates feedback on the expanded post-contract experience (§5.8), two intake paths for GHL vs site visitors (§5.7), and the empathy question set (§6.5).
