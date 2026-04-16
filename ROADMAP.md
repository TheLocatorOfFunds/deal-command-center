# Deal Command Center — Roadmap & Feature Ideas

A thinking document for where this system can go beyond its current scope. Not a commitment list — a brainstorm to reference when planning what to build next.

The Deal Command Center today is a small-team lead/deal tracker for flips and surplus fund cases. It has deals, expenses, tasks, vendors, notes, documents, activity feeds, assignment, flagging, search/filter/kanban, realtime sync, and magic-link auth.

The question this doc answers: **what else could it be?**

---

## How to use this doc

Each section below is a category of expansion. Within each category, features are listed with:

- **What** — one-line description
- **Why it matters** — the business reason to build it

When you're ready to prioritize, filter each idea through four questions:

1. Does it unlock more revenue, or just more organization? (Prefer revenue.)
2. Does it compound with data you already collect? (Features that get smarter over time beat one-shot features.)
3. Does it remove a manual step you do today? (Automation of existing friction always pays off.)
4. Does it enable a new audience to touch the system? (A VA, an attorney, a seller, an investor. These unlock org scale.)

---

## 1. Deeper on what it already does

Direct extensions of current features. Each one compounds with what's already built.

- **Lead intake form** — public URL that creates a deal in `new-lead` status when someone fills it out. Connect it to the website, mailer QR codes, cold-call dispositions. Removes the manual data-entry step.
- **Automated reminders** — Slack or email ping when a task is due, a deal goes stale, or a deadline is 48 hours out.
- **Drag-and-drop Kanban** — let users drag a card between columns to change status. Currently read-only. Status changes are already logged, so this is pure UX.
- **Bulk edit mode** — select 10 deals, assign them all to Inaam, change 5 leads to "dead" at once.
- **Templates for recurring deal structures** — e.g. "new flip from county tax auction" pre-fills lead source, typical fee %, etc.
- **Task templates per status** — when a surplus deal moves to `filed`, auto-generate the 5 tasks that always need to happen after filing.
- **Deal duplication** — clone an existing deal as a starting point for a similar one.
- **Inline editing on cards** — edit status, assignment, or address from the card without opening the detail view.

---

## 2. Money-making muscle

Where a deal tracker starts earning its keep beyond organization.

- **Pipeline forecasting** — "given current pipeline and historical conversion rates, expect $X closed in the next 30/60/90 days." Turns the dashboard into a revenue crystal ball.
- **Lead source ROI** — spend vs. profit by source (Google Ads, direct mail, referral, cold call). Tells you where to double-down on marketing.
- **Conversion funnel analytics** — percentage of leads that become under-contract, percentage of under-contract that close, time-in-stage averages. Find the leak in the pipeline.
- **County-level heatmap** — which counties produce the highest recovery per case; where to focus outreach.
- **Attorney scorecard** — win rate, avg days to recovery, fee split by attorney. Informs who to keep sending work to.
- **Commission calculator** — auto-split closing profit among the team based on who owned the deal / sourced the lead / executed. Removes the monthly "who gets what" conversation.
- **Cash flow forecast** — upcoming expenses (rehab draws, filing fees) netted against projected closings. Shows whether capital is needed next month.
- **Profit-per-hour calculations** — with time tracking, surface "deals with the highest hourly ROI" to decide what kind of work to take more of.
- **Historical P&L dashboard** — monthly/quarterly/yearly charts of profit, number of deals closed, avg profit per deal, by type.

---

## 3. Team & operations (scaling past a small team)

Features that let you grow to 10–20 people without operational chaos.

- **SOPs per status** — when a deal is in `under-contract`, the system shows the 8-step checklist the team should be running. Encodes tribal knowledge into the product.
- **Time tracking per deal** — who spent how long on what. Lets you calculate true per-deal profit (subtracting labor) and identify which deals chew up disproportionate time.
- **Performance dashboards** — deals closed per person, avg time-to-close, revenue generated. Quarterly review becomes data-driven.
- **VA workflow** — give a virtual assistant a queue of specific tasks (skip trace this list, make these cold calls) without giving them deal-level access.
- **Role-based access (RBAC)** — currently everyone sees everything. Split into owner / manager / closer / VA / external-attorney with progressively narrower views. Would require tightening Supabase RLS policies.
- **Training mode** — a "sandbox" workspace with fake deals new hires can practice on without polluting production data.
- **Capacity planning** — "Inaam is assigned 14 active deals, Eric has 3." Catches workload imbalance.
- **Internal messaging / mentions** — `@nathan` in a deal note sends him a notification. Turn the activity feed into a lightweight Slack-for-deals.
- **Daily standup digest** — each morning, email each team member their open tasks, stale deals, and today's deadlines.

---

## 4. External-facing surfaces

One of the most powerful unlocks: the same data serves different audiences differently.

- **Seller portal** — the homeowner you're recovering surplus funds for logs in (magic link) and sees their case status. Replaces "what's happening with my money" phone calls.
- **Investor / partner portal** — if anyone fronts capital, they see a filtered dashboard of deals they funded with live P&L.
- **Attorney portal** — external counsel sees only their assigned deals, uploads documents directly.
- **Referral partner portal** — people who send you leads see deals they referred and their earned commission. Builds loyalty and keeps referrals flowing.
- **Public stats page** — anonymized "X cases recovered, $Y returned to homeowners" for marketing. Builds credibility with county clerks and regulators.
- **Client-facing status timeline** — a pretty, step-by-step timeline showing sellers exactly where their case is in the process.
- **Branded PDF reports** — export a deal summary as a FundLocators-branded PDF to send to attorneys, investors, or clients.

---

## 5. Document & compliance

Surplus funds work has real legal teeth. Worth building before you need it.

- **Document auto-fill** — claim forms, LPOAs, assignment agreements filled in from deal data, exported as PDF.
- **E-signature integration** — DocuSign or Dropbox Sign embedded; track who signed what and when, store the signed doc in the deal.
- **Statute of limitations alerts** — each state has a different clock on surplus fund claims. Flag deals approaching expiration.
- **POA / authorization expiration tracking** — notify 30 days before a power of attorney expires.
- **Retention policy** — auto-archive documents after X years, per state regs.
- **Conflict-of-interest checks** — flag if a new deal involves a name already in your system in a competing role.
- **Compliance audit log** — already have activity feed; expand it into a tamper-resistant audit trail with immutable rows.
- **Document version history** — keep every uploaded version of a contract or claim form, not just the latest.
- **Per-state settings / templates** — automatically pick the right forms and deadlines based on the deal's state.

---

## 6. Intelligence & data enrichment

Every deal accumulates data. With enough of it, the system gets predictively smart.

- **AI deal triage** — new lead comes in; system estimates "expected value = $X, probability of recovery = Y%" based on county, case type, estimated surplus, time since filing. Tells you whether to take it.
- **Skip tracing integration** — auto-enrich leads with phone, email, current address (BatchSkipTracing, TLO, IDI).
- **County court scraping** — check the Franklin County case docket daily; when a case status changes, update the deal automatically.
- **Upcoming sheriff sale / tax sale calendar** — pull weekly auction schedules, map them to deal opportunities.
- **Comps for flips** — integrate Zillow/Redfin/Realtor APIs; show ARV comps automatically when a flip is entered.
- **End-buyer CRM** — track wholesale / retail buyers and what they've bought. When a new deal enters, auto-notify the 3 buyers most likely to want it.
- **Predictive deadline slippage** — based on historical data, flag which deals are likely to miss their closing date so you can intervene early.
- **Anomaly detection** — "this flip has 3x the repair budget of similar flips; might want to look at it."
- **Natural language query** — "show me all Ohio surplus cases over $20K filed in Q1." Plain English → filtered view.

---

## 7. Automation & integrations

Every integration turns a manual step into zero work.

- **Gmail / Outlook email sync** — all emails with a deal name or ID in the subject auto-attach to the deal's notes or documents.
- **Twilio phone integration** — click-to-call from a deal card; calls auto-log; voicemail transcripts go to the activity feed.
- **Calendar sync** — deadlines push to Google Calendar so they appear in your day.
- **Slack deal rooms** — each deal optionally has a Slack channel that mirrors the activity feed.
- **Zapier / Make webhook layer** — expose triggers (`deal.closed`, `status.changed`, `task.overdue`) and actions (`create deal`, `add task`) so non-developers can build workflows.
- **Accounting export** — monthly P&L CSV to QuickBooks / Wave / Xero. Or deeper: two-way sync.
- **Contract templates via e-sign providers** — Clio / DocuSign / HelloSign.
- **SMS blast** — send an SMS to a saved buyer list when a new wholesale deal is added.
- **Voice-memo-to-activity** — dictate an update on mobile, it transcribes and logs to the activity feed.
- **Map view** — deals pinned on a map, color-coded by status. Useful for driving routes to multiple properties.
- **iOS / Android native app** — wrapper around the same Supabase backend for field use.

---

## 8. Productizing it (moonshot)

You've built something genuinely useful. The surplus fund recovery industry runs on spreadsheets. If polished and opened to others, this is a distinct business line.

- **White-label for other surplus-fund recovery teams** — rename it, they bring their own Supabase project. $99–$299/month SaaS, or revenue share.
- **Flip-operator edition** — strip the surplus features, amp up rehab tracking, sell to house-flippers.
- **Vertical marketplace** — "FundLocators Network" where independent recovery operators list deals they can't staff, and other operators take them for a cut.
- **Training / coaching offering** — the Command Center becomes a credential. "I recovered $2M in surplus funds using this system — here's the course."
- **Data as a product** — sell anonymized county-level recovery stats to researchers, local newspapers, state regulators.
- **API access tier** — let power users build on top of your data with their own tools.

This is not a side feature. It'd be its own company. But the tool is most of the way there already.

---

## 9. Near-term high-leverage picks

If only three things could get built this quarter, these would produce the most leverage per engineering hour:

### 1. Pipeline forecasting dashboard
- You already log status + `actual_net` + `closed_at` on every deal.
- Build a view that calculates historical conversion rates (e.g. "85% of `under-contract` flips close") and applies them to the current pipeline.
- Result: dashboard that says "$X expected in next 60 days ± Y%."
- **Why it wins**: Transforms the app from a record-keeping tool into a decision-making tool.

### 2. Lead source ROI chart
- You already capture `lead_source` on every deal.
- Add a small monthly marketing-spend table (Google Ads: $1200, direct mail: $800, etc.).
- Plot: spend by source ÷ profit by source = ROI.
- **Why it wins**: Tells you where the next marketing dollar should go. Pays for itself the first time it redirects spend.

### 3. Seller / claimant portal
- Magic-link login for the homeowner whose surplus you're recovering.
- Read-only view of their case status, last update, estimated recovery.
- Massively reduces inbound "what's going on with my money" phone calls.
- **Why it wins**: Lowest build cost for highest customer-experience lift. Differentiates FundLocators from competitors.

---

## 10. How to propose new ideas

When someone has an idea not on this list, capture it with:

1. **What** — one sentence describing the feature.
2. **Who it's for** — internal team, seller, investor, VA, etc.
3. **Why now** — what problem it solves today.
4. **Data it depends on** — does it need new columns, or is everything already captured?
5. **Build estimate** — small (< 1 day), medium (1 week), large (> 1 week).

Append to this doc with PR, or add as a bullet under the matching section.

---

## Things explicitly out of scope

To keep this focused, we're not building:

- A full CRM replacement (HubSpot / Salesforce). Keep it deal-centric, not contact-centric.
- A full accounting system. Integrate with QuickBooks or equivalent instead of rebuilding it.
- A general-purpose project management tool (Asana / Monday). Keep it real-estate-specific.
- Public chat / social features. This is an internal operations tool.
- Mobile-only experiences that break the desktop flow. Mobile should complement, not replace.

---

## Changelog

- **2026-04-15** — Initial roadmap drafted. Current shipped features listed in `CLAUDE.md`.
