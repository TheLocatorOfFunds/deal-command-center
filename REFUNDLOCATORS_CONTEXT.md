# refundlocators.com — Context Brief for AI Collaborators

This document is the single source of truth for any AI session working on refundlocators.com. Read it first before writing code or making architectural decisions. It describes the business, the ecosystem, the product, the tech stack, and the unresolved questions.

> **How to use this doc**: paste this file (or link to it) at the start of any new Claude Code / AI session working on refundlocators. It replaces the need to re-explain the whole context.

---

## 1. Executive summary

**refundlocators.com** is an AI-powered consumer-facing website for people facing or recovering from foreclosure. It does three things:

1. **Chat** — an empathetic AI chatbot that educates users about their foreclosure situation, available options, and what surplus funds are.
2. **Search** — a lookup tool where a user enters their name/address/county to find out if they have unclaimed surplus funds from a foreclosure sale.
3. **Convert** — if the search returns surplus, the system texts the user a pre-filled DocuSign agreement so they can authorize FundLocators to recover the funds on their behalf — no phone call required.

The product's job is to **remove every point of friction between "I think I might have surplus" and "I've signed the agreement."** Humans only get involved after the user has signed.

---

## 2. The three-brand ecosystem

FundLocators (the parent company) operates three consumer-facing properties, each targeting a different stage of the foreclosure journey:

| Domain | Stage | Audience | What it does |
|---|---|---|---|
| **defenderha.com** | Pre-foreclosure | Homeowners at risk of foreclosure | Helps them defend their home, negotiate, understand options before the sale |
| **fundlocators.com** | Post-foreclosure (B2B / existing ops) | Industry partners, referrals | The established surplus-recovery business; manual sales process |
| **refundlocators.com** (new) | Post-foreclosure (consumer-direct, AI-led) | Former homeowners whose property was sold | Self-serve chat + search + instant sign-up for surplus recovery |

The three sites are distinct brands with distinct funnels, but they feed into the same backend operation: the **Deal Command Center** (DCC). Every signed agreement becomes a deal in DCC, regardless of which brand captured the lead.

**Why three brands?** Each stage has different emotional states and legal considerations. A pre-foreclosure homeowner is stressed and defensive; a post-foreclosure former owner is often surprised and sometimes skeptical. The messaging, tone, and legal framing have to differ.

---

## 3. The Deal Command Center (DCC) — what already exists

refundlocators.com does **not** replace DCC — it feeds DCC.

DCC is a live, production-deployed, single-page React + Supabase app that FundLocators internal team uses to manage every deal after it's signed. Key facts:

- **Repo**: https://github.com/TheLocatorOfFunds/deal-command-center
- **Live URL**: https://thelocatoroffunds.github.io/deal-command-center/
- **Stack**: React 18 (CDN, no build step) + Supabase (Postgres, Auth, Realtime, Storage) + GitHub Pages
- **Project ID**: Supabase `fmrtiaszjfoaeghboycn`
- **Auth model**: magic-link (passwordless email)
- **Data model summary**:
  - `deals` — the core entity. `type` ∈ {flip, surplus, wholesale, rental, other}. Has `status`, `address`, `meta` (jsonb), `actual_net`, `closed_at`, `assigned_to`.
  - `expenses`, `tasks`, `vendors`, `deal_notes`, `activity`, `documents` — all child tables keyed by `deal_id`.
  - Full schema + RLS details in `CLAUDE.md` in the DCC repo.

**What refundlocators needs to know about DCC**:

- DCC is the **destination** for every qualified lead that signs.
- When refundlocators produces a signed DocuSign agreement, it creates a new row in `deals` with `type = 'surplus'` and `status = 'new-lead'` (or `signed` depending on your status taxonomy).
- The `meta` jsonb is the preferred place to store refundlocators-specific metadata (chat transcript ID, search query, IP geo, etc.) without requiring schema migrations.
- DCC already has `lead_source` as a top-level column — use `lead_source = 'refundlocators-chat'` or `'refundlocators-search'` to distinguish intake channels.
- Use the Supabase **publishable key** for any client-side write from refundlocators. Never ship the service-role key to the browser.

**What refundlocators does NOT need to replicate**:

- Deal pipeline management (DCC does it).
- Team task assignment (DCC does it).
- Internal P&L tracking (DCC does it).
- Document storage for signed agreements (DCC already has a `documents` table + `deal-docs` storage bucket — refundlocators uploads there).

refundlocators' job ends when the signed agreement is in DCC.

---

## 4. End-to-end user journey

```
┌──────────────────────────────────────────────────────────────────────┐
│ 1. User lands on refundlocators.com                                  │
│    (from Google ad, direct mail, word of mouth, defenderha handoff)  │
└──────────────────────────────────────────────────────────────────────┘
                                  ↓
┌──────────────────────────────────────────────────────────────────────┐
│ 2. Chat bubble greets them + search box is front and center          │
│    Two paths available:                                              │
│    (a) Start chat — educational, empathy-first                       │
│    (b) Search immediately — "Find my surplus"                        │
└──────────────────────────────────────────────────────────────────────┘
                                  ↓
┌──────────────────────────────────────────────────────────────────────┐
│ 3. Search: user enters name + county + (optional) address            │
│    System queries the surplus database (populated from county        │
│    records). Returns match / partial match / no match.               │
└──────────────────────────────────────────────────────────────────────┘
                                  ↓
┌──────────────────────────────────────────────────────────────────────┐
│ 4a. MATCH FOUND                                                      │
│     - Show claim estimate (educational, NOT guarantee)               │
│     - Chat agent explains next steps in plain English                │
│     - Ask for phone number with clear TCPA consent                   │
│     - Fire DocuSign pre-fill request (name, address, case #, fee %)  │
│     - Send SMS via GHL with signing link                             │
└──────────────────────────────────────────────────────────────────────┘
                                  ↓
┌──────────────────────────────────────────────────────────────────────┐
│ 5. User e-signs on their phone                                       │
│    DocuSign webhook fires → refundlocators backend                   │
└──────────────────────────────────────────────────────────────────────┘
                                  ↓
┌──────────────────────────────────────────────────────────────────────┐
│ 6. Backend creates deal in DCC (Supabase insert into `deals`)        │
│    - type = 'surplus'                                                │
│    - status = 'signed' (or 'new-lead')                               │
│    - lead_source = 'refundlocators-chat' | '-search'                 │
│    - meta = { chat_transcript_id, search_query, docusign_envelope_id,│
│               estimated_surplus, county, case_number }               │
│    - Signed PDF uploaded to `deal-docs/{deal_id}/agreement.pdf`      │
└──────────────────────────────────────────────────────────────────────┘
                                  ↓
┌──────────────────────────────────────────────────────────────────────┐
│ 7. FundLocators internal team sees the new deal in DCC in realtime   │
│    Assigned automatically (round-robin) or manually                  │
│    Case is worked using existing DCC workflows                       │
└──────────────────────────────────────────────────────────────────────┘
                                  ↓
┌──────────────────────────────────────────────────────────────────────┐
│ 4b. NO MATCH FOUND                                                   │
│     - Do NOT say "you have no surplus" (may have false negative)     │
│     - Say "we didn't find a match in our database — chat to discuss" │
│     - Capture their info for manual follow-up                        │
│     - Create lightweight lead in DCC with status = 'needs-manual-    │
│       lookup'                                                         │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 5. Technical architecture

### 5.1 Proposed stack

| Layer | Technology | Why |
|---|---|---|
| Frontend | Next.js 14+ (App Router) on Vercel | SEO matters for consumer search; server components for fast initial load; Vercel for CI/CD |
| Database | Supabase (separate project or shared with DCC — see §7) | Team already fluent; pgvector for chat embeddings; consistent with DCC |
| AI chatbot | OpenAI API (GPT-4o) or Claude API (Sonnet 4.5) | Streaming responses, tool use for search, empathy-tuned system prompt |
| Search index | Supabase Postgres + trigram index (names) + exact match (counties/addresses) | Simple, cheap, sufficient at expected scale |
| SMS | GoHighLevel (GHL) — already in use | Existing vendor relationship; GHL has compliance features built in |
| E-sign | DocuSign (or HelloSign) | Industry standard; pre-fill via template API |
| Auth (for claimants) | Magic-link via Supabase | No passwords = less abandonment |
| Analytics | PostHog (recommended) | Session replay helps debug chat flows; funnel analytics |

### 5.2 Why separate from DCC repo

- DCC is a single-file HTML for internal team use. refundlocators is consumer-facing, needs SEO, needs a CI/CD pipeline, needs multiple environments (staging + prod).
- Different deployment cadence — DCC is "push to live"; refundlocators needs more protection.
- Different tech stacks are OK if they share a Supabase project.

### 5.3 Critical interfaces

```
refundlocators.com (Next.js on Vercel)
         │
         ├── reads/writes Supabase shared data
         ├── calls OpenAI/Claude API for chat
         ├── calls DocuSign API to create + send envelope
         ├── receives DocuSign webhook → inserts into `deals`
         └── calls GHL API to send SMS
```

---

## 6. Data model decisions

### 6.1 Shared vs. separate Supabase project

**Recommendation**: **shared project, separate schemas.**

- Schema `public` (existing) — DCC tables, untouched.
- Schema `rfl` (new) — refundlocators-specific tables: `chat_sessions`, `search_queries`, `surplus_records`, `unverified_leads`.
- `deals` stays in `public`; refundlocators inserts into it when conversion happens.

**Why shared**:
- Single identity system for team (magic link to same auth.users).
- Team can see both lead activity and deal activity in one place.
- Cheaper (one Supabase project vs. two).
- Cross-schema foreign keys are supported.

**Why NOT shared**:
- If refundlocators ever becomes a separate product / gets sold / needs a different compliance posture, separation is cleaner.

Pick shared for now; migrate later if it outgrows the decision.

### 6.2 New tables (proposed)

```sql
-- Schema: rfl

create table rfl.surplus_records (
  id uuid primary key default gen_random_uuid(),
  state text not null,           -- 'OH', 'IN', etc.
  county text not null,
  case_number text,
  debtor_name text not null,
  property_address text,
  sale_date date,
  estimated_surplus numeric,
  source_url text,               -- where we scraped/obtained this record
  claimed_at timestamptz,        -- populated when a user matches + signs
  created_at timestamptz default now()
);
create index on rfl.surplus_records using gin (debtor_name gin_trgm_ops);
create index on rfl.surplus_records (county);

create table rfl.chat_sessions (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz default now(),
  last_message_at timestamptz,
  ip text,
  user_agent text,
  state text,                    -- derived from IP, self-reported
  phone text,
  email text,
  consent_tcpa boolean default false,
  consent_tcpa_at timestamptz,
  outcome text,                  -- 'signed' | 'abandoned' | 'no-match' | 'manual-followup'
  deal_id text references public.deals(id),  -- populated if converted
  transcript jsonb               -- [{role, content, ts}]
);

create table rfl.search_queries (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references rfl.chat_sessions(id),
  query_name text,
  query_county text,
  query_address text,
  results_count int,
  top_result_id uuid references rfl.surplus_records(id),
  created_at timestamptz default now()
);

create table rfl.unverified_leads (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references rfl.chat_sessions(id),
  name text, phone text, email text, address text, county text, state text,
  notes text,
  promoted_to_deal_id text references public.deals(id),
  created_at timestamptz default now()
);
```

All RLS-locked to service role for refundlocators backend writes. Internal team reads via their DCC auth.

### 6.3 Shared `profiles` / `contacts`

Don't try to unify "claimants" with FundLocators internal team. Keep them separate:

- `auth.users` — continues to be internal team only.
- `rfl.chat_sessions` / `rfl.unverified_leads` — stores claimant identity loosely until they sign.
- After signing, the signed DocuSign document is the source of truth for their identity; store in `deal.meta.signer_info`.

---

## 7. Integration specifics

### 7.1 DocuSign integration

- Use DocuSign **Connect** webhooks to get notified when envelope is signed.
- Use DocuSign **templates** with pre-fill tabs for: name, property address, county, case number, fee percentage, sale date.
- The template is created once in DocuSign admin; refundlocators passes data to fill the tabs.
- Webhook endpoint lives on refundlocators backend (e.g. `/api/docusign/webhook`).
- On `envelope-completed` event: download the signed PDF, upload to Supabase storage at `deal-docs/{deal_id}/agreement-signed.pdf`, insert deal row.

### 7.2 GHL integration

- GHL has both a REST API and webhook surface.
- Send SMS via GHL API: `POST /conversations/messages` with the DocuSign signing URL.
- Consent: **do not send unsolicited SMS.** User must give explicit TCPA-compliant consent in the chat UI before any SMS is sent. Record consent in `rfl.chat_sessions.consent_tcpa`.
- Inbound SMS replies should also be routed to GHL for the team to handle.

### 7.3 AI chatbot

**Tone**: empathy-first. The audience has experienced financial distress. Avoid legalese unless necessary. Never say "you definitely have surplus" or "we guarantee recovery" — always frame in probabilistic, educational terms.

**Grounding**:
- Load system prompt from a config file (easy iteration).
- Give the bot tools:
  - `search_surplus_records(name, county, address?)` — calls Supabase
  - `explain_surplus_funds()` — returns educational content
  - `capture_contact_info(name, phone, email)` — writes to `rfl.unverified_leads`
  - `send_signing_link(session_id, record_id)` — triggers DocuSign + GHL
- Bot should refuse to: give legal advice, promise recovery amounts, disparage competitors.

**Transcript storage**:
- Every message persisted to `rfl.chat_sessions.transcript` as jsonb.
- On conversion, copy transcript reference to `deal.meta.chat_transcript_id` so internal team can review the lead's journey.

### 7.4 Surplus records ingestion

**This is the hardest part of the project.** Populating `rfl.surplus_records` requires scraping or licensing data from county court systems.

Options:
1. **Per-county scraping**: write Python/Node scrapers for each target county's public records website. Run daily via cron. High maintenance but free.
2. **Licensing from a data provider**: companies like DataTree, Black Knight, or regional providers sell foreclosure data. Paid but turn-key.
3. **Manual intake**: internal team uploads CSV dumps monthly for target counties.

Start with #3 (manual CSV), move to #1 for top 3–5 revenue-producing counties, consider #2 when scale justifies it.

---

## 8. Compliance landmines

**Do not skip this section. Mistakes here can end the business.**

### 8.1 TCPA (Telephone Consumer Protection Act)

- Do NOT send SMS without explicit prior written consent. "Prior written consent" includes a check box on the web form with clear disclosure.
- The consent language must name FundLocators, disclose that message frequency varies, include STOP/HELP instructions, and note that consent is not a condition of service.
- Store timestamp + exact text of consent shown + IP + session ID.
- Violations are $500–$1500 per message. This is not theoretical.

### 8.2 State surplus fund laws

- Many states **regulate who can solicit surplus fund recipients and how.**
- Some states require licensure (e.g. as a "surplus fund recovery agent").
- Some states **cap fees** (e.g. 10% max in certain states).
- Some states **prohibit outreach for X days after the foreclosure sale** (cooling-off period).
- Before launching in a state, confirm: (a) solicitation is legal, (b) fee cap, (c) cooling-off period, (d) licensure requirements.
- **Start with 1–2 friendly states** (e.g. Ohio, Indiana) and expand once the compliance posture is proven.

### 8.3 Data privacy

- Chat transcripts contain PII. Retain only as long as needed; consider 90-day auto-delete for abandoned sessions.
- If a user asks "delete my data" — honor it. Build a deletion endpoint.
- Don't log full names / SSNs / financial info to application logs. Use redaction in logging middleware.

### 8.4 Advertising claims

- Don't say "we recovered $X million." If you do, be able to document it with closed deals from DCC.
- Don't use words like "guaranteed" in marketing copy.
- Testimonials must be real and disclose if compensated.

---

## 9. MVP scope (what to build first)

The temptation with a big vision is to build everything. Resist. Here's the sequenced MVP:

### Phase 1 — Static Search (2–3 weeks)
- Next.js site on Vercel
- Landing page with branding + TCPA-compliant consent flow
- Search form: name + county
- Backend query into `rfl.surplus_records` (seeded manually from CSV for 1 county)
- Match → show result, capture email/phone
- No chat yet, no DocuSign yet

### Phase 2 — Chat Layer (2 weeks)
- Add AI chatbot sidebar
- Chatbot has the 4 tools listed in §7.3
- Transcripts saved
- "No match" leads go to `rfl.unverified_leads`
- Internal team reviews unverified leads daily

### Phase 3 — DocuSign + SMS (2–3 weeks)
- DocuSign template created
- Webhook integration
- GHL SMS integration
- On signed envelope → deal created in DCC
- Full end-to-end loop working

### Phase 4 — Expand surplus records (ongoing)
- Script ingestion from top 3 counties
- Daily refresh cron
- Monitor match-rate metrics

### Phase 5 — Optimization
- Analytics (funnel, session replay, A/B tests)
- Retargeting for abandoned sessions
- Multi-state expansion (with compliance review per state)

**Do not build phases 2–5 in parallel.** Each phase's learnings change what the next phase should look like.

---

## 10. Open questions (decide before building)

These need clear answers before committing code. Document the decisions in this file once made.

1. **Supabase project**: shared with DCC or separate? *(Leaning shared — see §6.1.)*
2. **AI provider**: OpenAI or Claude? *(Claude is more aligned for empathy + safety; OpenAI has more voice/image capability.)*
3. **Which counties first?** Pick 1–2 where FundLocators already has strong operational relationships + clear state-level legal posture.
4. **Fee percentage** shown in search results: fixed, or vary by case size? *(Fixed is simpler for MVP; variable lets you optimize per case.)*
5. **Who owns the signed DocuSign agreement legally?** FundLocators corporate, or a per-state LLC?
6. **What does "no match" do?** Silent fail, or proactive chat engagement?
7. **Chatbot handoff to human**: when and how? (E.g. after 5 messages, after a complex question, after a specific keyword.)
8. **Branding crossover**: should the signed agreement mention refundlocators, fundlocators, or both? Trademark / brand consistency.
9. **Attribution**: how do we track which refundlocators session produced which DCC deal? *(Via `deal.meta.chat_session_id` — already proposed in §6.2.)*
10. **Return user flow**: someone comes back a month later — do we remember them? How? Without becoming creepy.

---

## 11. How this connects to `ROADMAP.md`

The DCC roadmap has several features that align directly with refundlocators:

- **ROADMAP.md §1 — Lead intake form** → refundlocators IS this, at scale, with AI.
- **ROADMAP.md §4 — Seller portal** → refundlocators could become the seller portal (former homeowners log in to see case status).
- **ROADMAP.md §5 — Document auto-fill** → DocuSign integration here satisfies this.
- **ROADMAP.md §6 — AI deal triage** → the chatbot + search is the frontend of this.
- **ROADMAP.md §6 — County court scraping** → surplus records ingestion IS this.
- **ROADMAP.md §7 — SMS blast, webhook layer** → GHL integration is the foundation.

In other words: building refundlocators builds out 40% of the DCC roadmap as a side effect. Every Claude session working on refundlocators should consider whether their work can be designed to double as a DCC feature.

---

## 12. How other AI collaborators should use this doc

If you're a Claude Code / AI session just starting work on refundlocators.com, do the following:

1. **Read this entire document once.** Do not skim.
2. **Confirm you have access to** the refundlocators.com repo (once it exists), the Supabase project, the GHL workspace, and the DocuSign account.
3. **Before writing code**, state back what you understand about the user journey (§4), the current phase of MVP (§9), and which of the open questions (§10) are relevant to your task.
4. **When in doubt**, default to: empathy, compliance, simplicity, and "will this scale from 1 county to 50?"
5. **Do not**: disable TCPA consent, make up surplus estimates, skip the activity trail, or hardcode state-specific assumptions.
6. **Reference DCC's `CLAUDE.md`** for architectural patterns to follow (though stack is different, philosophy is shared).
7. **Update this file** as decisions are made. Append to §10 when an open question gets answered.

---

## 13. Links

| What | Where |
|---|---|
| DCC repo | https://github.com/TheLocatorOfFunds/deal-command-center |
| DCC live | https://thelocatoroffunds.github.io/deal-command-center/ |
| DCC primer | `CLAUDE.md` in DCC repo |
| DCC onboarding | `ONBOARDING.md` in DCC repo |
| DCC roadmap | `ROADMAP.md` in DCC repo |
| Supabase dashboard | https://supabase.com/dashboard/project/fmrtiaszjfoaeghboycn |
| refundlocators.com | *(TBD — not launched yet)* |
| defenderha.com | https://defenderha.com |
| fundlocators.com | https://fundlocators.com |
| DocuSign dev portal | https://developers.docusign.com/ |
| GoHighLevel API | https://highlevel.stoplight.io/ |
| TCPA guidelines (FCC) | https://www.fcc.gov/consumers/guides/stop-unwanted-robocalls-and-texts |

---

## 14. Team

- **Nathan Johnson** (nathan@fundlocators.com) — owner
- **Justin** (justin@fundlocators.com) — co-founder / developer
- Additional team members: Eric, Inaam

Decision-making authority: Nathan has final say on product direction, brand, and compliance; Justin has final say on technical architecture.

---

## 15. Changelog

- **2026-04-16** — Initial context brief drafted during session with Nathan. No code written yet. Core decisions pending (see §10).
