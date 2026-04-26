# Deal Command Center — Full Recreation Spec

> ⚠️ **DRIFT WARNING — read before trusting any detail in this doc**
>
> This file is a **point-in-time snapshot** (first written 2026-04-24). The DCC
> codebase + Supabase schema evolve continuously; this doc doesn't auto-update.
> By the time you read it, specifics (table columns, Edge Function names, tab
> lists) may no longer match production.
>
> **Single source of truth is always the current codebase + live Supabase
> project `rcfaashkfpurkvtmsmeb`.** If this doc disagrees with them, they win.
>
> **Nothing imports or executes this file.** It's reference-only. Safe to let
> drift; safe to delete; safe to fork and modify. No code references break if
> it goes stale or away.

---

**Purpose:** a complete, self-contained brief for a fresh Claude Code session to rebuild
Nathan Johnson's Deal Command Center (DCC) from zero. Everything needed is in this file.
No "see other doc X" — if it matters, it's in here.

**Read in full before writing any code.** Then start at §4 and work down.

---

## 0. How to read this doc

Two tracks running in parallel:

- **Technical spec** — real specifics: SQL, code skeletons, service names, versions
- **ELI5 sidebars** (🧒) — plain-English analogies for anyone non-technical reading along

Skip the 🧒 blocks if you're the building AI. Include them when sharing with Nathan.

---

## 1. What DCC is (ELI5)

🧒 **The analogy:** imagine a family fire-and-rescue operation. Someone's house burned down
and the city is holding money they owed that person but can't find them. Nathan's company
finds those people and helps them get their money back. To do that, he needs a giant
mission-control room where every family's case lives — who they are, what their house was
worth, where the court case is, who the lawyer is, what texts we've sent, what paperwork
we have. DCC is that mission-control room, but inside a web browser, on his phone, and on
his team's laptops. Everyone sees the same live wall of information, and a robot assistant
helps keep it all up to date.

🧒 **The four "rooms" in the building:**
1. **The team room** (DCC) — where Nathan and his helpers work
2. **The family room** (client portal) — each family signs in and sees their own case
3. **The lawyer room** (attorney portal) — partner attorneys sign in and see only the
   cases they're working on
4. **The public sign-up room** (lead intake) — anyone on the internet can say "I think I'm
   owed money, please help"

There are two more quiet rooms most people never see: an investor room (for people buying
houses Nathan flips) and a seller room (where the homeowner fills out a questionnaire
about their property).

**The "secret weapon":** every piece of paperwork the county posts about one of these
cases gets scraped into the system automatically by a different program called **Castle**.
The system knows when there's a new court filing before the homeowner does.

---

## 2. Technical shape (ELI5 + detail)

🧒 **Plain version:** DCC is four single-page websites that all talk to the same brain.
The brain is a database. The websites are just nice-looking pages that show you what's in
the brain and let you change it. No phones apps, no special software to install.

**Architecture:**

```
                    ┌─────────────────────────────────────┐
                    │        Supabase project             │
                    │  (the "brain" — rcfaashkfpurkvtmsmeb)│
                    │                                     │
                    │  • Postgres DB (tables + RLS)       │
                    │  • Auth (magic link + password)     │
                    │  • Realtime (live updates)          │
                    │  • Storage (deal-docs bucket)       │
                    │  • Edge Functions (Deno serverless) │
                    │  • Vault (API keys)                 │
                    │  • pg_cron (scheduled jobs)         │
                    │  • pg_net (outbound HTTP)           │
                    │  • pgvector (semantic search)       │
                    └─────────────────────────────────────┘
                              ↑         ↑         ↑
              ┌───────────────┘         │         └──────────────┐
              │                         │                        │
   ┌────────────────────┐   ┌────────────────────┐   ┌────────────────────┐
   │  DCC (team app)    │   │  Client portal     │   │  Attorney portal   │
   │   index.html       │   │   portal.html      │   │ attorney-portal.html│
   └────────────────────┘   └────────────────────┘   └────────────────────┘

   ┌────────────────────┐   ┌────────────────────┐   ┌────────────────────┐
   │  Investor portal   │   │  Homeowner intake  │   │  Public lead form  │
   │ investor-portal.html│  │ homeowner-intake.html│ │  lead-intake.html  │
   └────────────────────┘   └────────────────────┘   └────────────────────┘
```

**The HTML files are DUMB.** They load React + Babel + Supabase JS from CDNs, transpile
JSX in the browser, and talk to Supabase directly. No Node build step. No webpack. No
package.json. One file per portal. Ship by pushing to `main` on GitHub; Pages rebuilds in
30 seconds.

🧒 **Why one file?** Nathan doesn't have a build server. Every change is "edit the file,
save, git push." A fresh pair of eyes can read the whole app top to bottom. No framework
lock-in.

**Hosting:** GitHub Pages on `main` branch root of the `deal-command-center` repo. Custom
domain `app.refundlocators.com` via CNAME file.

**External services used:**
| Service | Purpose |
|---|---|
| Supabase | Everything on the backend |
| Resend | Outbound email (DKIM-verified on refundlocators.com) |
| Twilio | SMS + Voice |
| Anthropic API | Claude Vision (OCR docs), Claude Sonnet (summaries) |
| OpenAI | text-embedding-3-small (pgvector embeddings for Lauren) |
| Cloudflare DNS | refundlocators.com zone |
| GitHub | Source code + Pages hosting |

**Supplementary native daemon:** a Node.js bridge (`mac-bridge/bridge.js`) runs on
Nathan's always-on Mac Mini, polls iMessage's `chat.db` for inbound messages, and
uses AppleScript to send outbound iMessages. This is how Nathan keeps his personal
phone number (+15135162306) as the one-true outbound line.

---

## 3. External accounts + services to set up first

**Do these in this order before any code.** Each is ~5-10 min.

1. **GitHub** — create a repo `deal-command-center`. Enable Pages from `main` branch root.
   Add a `CNAME` file with your custom domain once ready.
2. **Supabase** — create a new project. Copy the project ref (e.g. `rcfaashkfpurkvtmsmeb`),
   URL, and publishable (anon) key. Never put the service-role key in client code.
3. **Domain (Cloudflare or other)** — set up two subdomains:
   - `app.example.com` → CNAME to `<username>.github.io`
   - `www.example.com` → your marketing site (optional)
4. **Resend** — create account, add your domain, verify DKIM. Store API key in Supabase
   Vault as `resend_api_key`.
5. **Twilio** — buy a phone number ($1/mo). For real sending: upgrade out of trial ($20
   credit + credit card). Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
   `TWILIO_FROM_NUMBER` as Supabase Edge Function secrets.
6. **Anthropic** — create API key. Store as `ANTHROPIC_API_KEY` in Edge Function secrets.
7. **OpenAI** — create API key for embeddings. Store as `OPENAI_API_KEY` in Edge Function
   secrets.

🧒 **Why all the keys?** Different services cost money and need to know it's really you
calling them. Keys are like passwords for computers talking to each other.

---

## 4. Auth model + roles

**Four roles** driven by `profiles.role`:

| Role | Who | Where they sign in |
|---|---|---|
| `admin` (or legacy `user`) | Nathan / team with full access | DCC (index.html) |
| `va` | Virtual assistants — no financials | DCC (index.html), financials hidden |
| `attorney` | Partner attorneys | attorney-portal.html |
| `client` | Homeowners whose cases we work | portal.html |

**Magic-link auth** via `supabase.auth.signInWithOtp({ email })`. Emails arrive via
Resend. First sign-in auto-creates `auth.users` + `profiles` row via the
`handle_new_user` trigger.

**Role assignment** by `handle_new_user`:
1. Email matches pending `client_access` row → role = `client`, links `user_id`
2. Else email matches pending `attorney_assignments` row → role = `attorney`
3. Else → role = `user` (admin). Future tightening: require manual admin approval.

🧒 **How this works:** when a homeowner first clicks the "sign in" link in the email
Nathan sent them, the system looks at their email address and says "oh, they're
connected to Casey Jennings' case" and automatically gives them the right level of
access. Same for attorneys. Everyone else → no access.

---

## 5. Database schema (create in this order)

All tables in the `public` schema. All primary keys `uuid` except `deals.id` which is
`text` (pattern `sf-<lastname>` for surplus, `flip-<street>` for flips).

### 5.1 Core identity

```sql
-- profiles: 1:1 with auth.users
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text,
  role text check (role in ('admin','user','va','attorney','client')) default 'user',
  created_at timestamptz not null default now()
);

-- Helper functions (SECURITY DEFINER so they bypass profile RLS)
create or replace function public.is_admin() returns boolean ...
create or replace function public.is_va() returns boolean ...
create or replace function public.is_attorney() returns boolean ...
create or replace function public.is_client() returns boolean ...
-- Each reads profiles.role for auth.uid() and returns bool.

-- Auto-role assignment on signup
create or replace function public.handle_new_user() returns trigger ...
-- Reads the new row's email, checks client_access + attorney_assignments,
-- inserts matching profiles row with correct role + user_id.
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();
```

### 5.2 Core entities

```sql
-- Deals — the central entity
create table public.deals (
  id text primary key,
  type text check (type in ('flip','surplus','wholesale','rental','other')) not null,
  status text not null,                                 -- new-lead / lead / signed / filed / ...
  name text,                                            -- "Casey Jennings - 7260 Jerry Dr"
  address text,
  meta jsonb not null default '{}',                     -- grab-bag: county, courtCase, estimatedSurplus, homeownerPhone, feePct, attorney, welcome_video, investor{}, case_intel_summary{}, ...
  owner_id uuid references auth.users(id) on delete set null,
  assigned_to text,                                     -- team member name (text, not FK)
  lead_source text,                                     -- "refundlocators.com" / "Castle" / "manual"
  deadline date,
  filed_at date,
  actual_net numeric,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Castle-populated columns
  lead_tier text,                                       -- 'A' | 'B' | 'C' | null
  is_30dts boolean default false,                       -- 30-day-to-sale flag
  death_signal boolean default false,
  surplus_estimate numeric,
  days_to_sale int,
  scored_at timestamptz,
  sales_stage text default 'new',                       -- Kanban stage for surplus track
  sales_stage_30dts text,                               -- Kanban stage for 30DTS track
  last_contacted_at timestamptz,
  refundlocators_token text                             -- UUID for the /s/[token] landing page
);

-- Contacts (company-wide CRM) vs Vendors (per-deal)
create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  name text not null, company text, email text, phone text,
  kind text,                                            -- 'homeowner'|'spouse'|'child'|'sibling'|'family'|'neighbor'|'attorney'|'title_company'|'investor'|'referral_source'|'partner'|'vendor'|'other'
  kind_other text,                                      -- when kind='other', free-text label
  tags text[], notes text, financial_notes text,
  owner_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.contact_deals (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.contacts(id) on delete cascade,
  deal_id text not null references public.deals(id) on delete cascade,
  relationship text,                                    -- "attorney of record" / "son of homeowner"
  sms_opted_out_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique(contact_id, deal_id)
);
```

🧒 **`contacts` vs `vendors` confusion:** `contacts` = a person/company at the company
level (partner attorney, investor who buys multiple flips). `vendors` = a contractor
or vendor scoped to ONE deal (the electrician for the 7260 Jerry Dr flip). Don't
conflate.

### 5.3 Per-deal children

```sql
-- All of these cascade-delete when parent deal deletes
create table public.activity (...);        -- audit log: action, user_id, created_at, visibility text[], activity_type, outcome, body, next_followup_date
create table public.tasks (...);           -- title, due_date, done, priority, assigned_to
create table public.expenses (...);        -- category, amount, date, vendor, notes
create table public.vendors (...);         -- per-deal contractors: name, role, phone, email
create table public.deal_notes (...);      -- title, body, author_id, updated_at
create table public.documents (...);       -- name, path, size, uploaded_by, extracted jsonb, extraction_status, extraction_error
create table public.messages (...);        -- team↔client↔attorney in-app: sender_role, sender_id, sender_name, body, subject, audience text[]
```

### 5.4 Access + routing

```sql
create table public.client_access (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  deal_id text references public.deals(id) on delete cascade,
  email text, enabled boolean default true,
  last_seen_at timestamptz, prefs jsonb default '{}',
  ...
);

create table public.attorney_assignments (
  -- same shape as client_access
);

-- Auto-sync attorney_assignments from contact_deals where contacts.kind='attorney'
create trigger tg_sync_attorney_assignments_from_contact_deal ...;
```

### 5.5 Lead intake + Castle

```sql
create table public.leads (                             -- public form submissions
  id uuid primary key default gen_random_uuid(),
  name text not null, email text, phone text, address text, county text, case_number text,
  status text default 'new',                            -- new / contacted / signed / dismissed
  metadata jsonb,                                        -- UTM params, referrer, dup-detection scores
  contacted_at timestamptz, converted_to_deal_id text,
  created_at timestamptz not null default now()
);

create table public.docket_events (                     -- Castle-ingested court events
  id uuid primary key default gen_random_uuid(),
  deal_id text references public.deals(id) on delete cascade,
  external_id text,                                     -- Castle's unique ID
  event_type text,                                      -- disbursement_ordered / hearing_scheduled / judgment_entered / ...
  event_date date, description text,
  court_system text, case_number text, county text,
  document_url text, document_ocr_id uuid,
  raw jsonb, detected_at timestamptz, received_at timestamptz,
  acknowledged_at timestamptz, acknowledged_by uuid,
  castle_case_id text, is_backfill boolean default false,
  unique(deal_id, external_id)
);
create table public.docket_events_unmatched (...);      -- staging: events Castle sent before we had a matching deal

create table public.scrape_runs (                       -- Castle heartbeats
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz, completed_at timestamptz,
  county text, deals_checked int, events_found int, events_new int,
  status text, errors jsonb, notes text, scraper_version text
);
```

### 5.6 Communications (SMS + Voice + Email)

```sql
create table public.phone_numbers (                     -- Twilio numbers in rotation
  id uuid primary key default gen_random_uuid(),
  label text, number text unique, active boolean default true,
  gateway text default 'twilio',                        -- 'twilio' | 'mac_bridge'
  created_at timestamptz not null default now()
);

create table public.messages_outbound (                 -- SMS + iMessage log
  id uuid primary key default gen_random_uuid(),
  deal_id text references public.deals(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  thread_key text,                                      -- '<deal>:contact:<id>' or '<deal>:group:<id>' or '<deal>:phone:<e164>'
  group_id uuid,                                        -- for group iMessages
  channel text,                                         -- 'sms' | 'imessage'
  direction text,                                       -- 'outbound' | 'inbound'
  to_number text, from_number text, body text,
  status text,                                          -- 'queued' | 'sent' | 'failed' | 'received' | 'pending_mac'
  twilio_sid text, error_code text, error_message text,
  sent_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create table public.messages_outbound_unmatched (...);  -- inbound from numbers not linked to any deal
create table public.thread_hidden (...);                -- soft-archive noisy threads
create table public.message_groups (                    -- group chat threads
  id uuid primary key default gen_random_uuid(),
  deal_id text references public.deals(id),
  label text, participants jsonb, channel text,
  created_at timestamptz default now()
);

create table public.call_logs (                         -- Twilio Voice audit
  id uuid primary key default gen_random_uuid(),
  deal_id text references public.deals(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  thread_key text,
  direction text, from_number text, to_number text,
  duration_seconds int, status text,                    -- 'ringing' | 'completed' | 'missed' | 'no-answer' | 'busy' | 'failed'
  recording_url text, recording_duration int, recording_sid text,
  twilio_call_sid text unique,
  started_at timestamptz, ended_at timestamptz,
  auto_sms_sent boolean default false,
  created_at timestamptz default now()
);

create table public.emails (                            -- Resend outbound + inbound audit
  id uuid primary key default gen_random_uuid(),
  deal_id text, contact_id uuid, thread_key text,
  direction text default 'outbound',
  from_email text, to_emails text[], cc_emails text[], bcc_emails text[],
  reply_to text, subject text, body_text text, body_html text,
  resend_id text, status text, error_message text,
  sent_by uuid, created_at timestamptz default now()
);

create table public.sms_templates (                     -- Tier-based outbound templates
  id uuid primary key default gen_random_uuid(),
  label text, tier text,                                -- 'A' | 'B' | 'C' | '30DTS' | 'any'
  body_template text,                                   -- with [FirstName], [OwnerName], [sale_date], [token], [County] merge vars
  active boolean default true,
  created_at timestamptz default now()
);
```

### 5.7 Token-gated portal access (no auth required)

```sql
create table public.investor_deal_access (
  id uuid primary key default gen_random_uuid(),
  token uuid unique default gen_random_uuid(),
  deal_id text references public.deals(id),
  buyer_name text, buyer_email text, buyer_phone text,
  enabled boolean default true, revoked_at timestamptz,
  invited_at timestamptz default now(), last_viewed_at timestamptz,
  invited_by uuid
);

create table public.homeowner_intake_access (
  id uuid primary key default gen_random_uuid(),
  token uuid unique default gen_random_uuid(),
  deal_id text references public.deals(id),
  homeowner_name text, homeowner_email text, homeowner_phone text,
  enabled boolean default true, revoked_at timestamptz,
  invited_at timestamptz default now(),
  last_viewed_at timestamptz, completed_at timestamptz, submission_count int default 0,
  invited_by uuid
);

create table public.walkthrough_requests (...);         -- investor-initiated showings
create table public.investor_offers (...);              -- investor bids on flips
```

### 5.8 Lauren (AI assistant)

```sql
create extension if not exists vector;

create table public.lauren_conversations (
  id uuid primary key default gen_random_uuid(),
  session_id uuid, role text,                           -- 'user'|'assistant'|'tool'
  content text, tool_call jsonb, tool_result jsonb,
  created_at timestamptz default now()
);

create table public.lauren_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid, deal_id text,
  status text,                                          -- 'working' | 'done' | 'abandoned'
  started_at timestamptz default now(), ended_at timestamptz
);

create table public.lauren_knowledge (                  -- pgvector knowledge base
  id uuid primary key default gen_random_uuid(),
  title text, body text, source text,                   -- 'playbook' | 'orc_statute' | 'county_rule' | ...
  embedding vector(1536),                               -- OpenAI text-embedding-3-small
  created_at timestamptz default now()
);
create index on public.lauren_knowledge using ivfflat (embedding vector_cosine_ops);
```

---

## 6. RLS model

Every table needs `alter table X enable row level security;` and at least admin
policies. The four roles map to four policy patterns:

```sql
-- Admin: full access
create policy admin_all_X on public.X for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- VA: read + write except expenses + financial_notes
create policy va_all_X on public.X for all to authenticated
  using (public.is_admin() or public.is_va()) with check (public.is_admin() or public.is_va());

-- Attorney: read-only, scoped to assigned deals
create policy attorney_read_X on public.X for select to authenticated
  using (
    public.is_attorney()
    and deal_id in (select deal_id from public.attorney_assignments
                    where user_id = auth.uid() and enabled = true)
  );

-- Client: read-only, scoped to their deals via client_access
create policy client_read_X on public.X for select to authenticated
  using (
    public.is_client()
    and deal_id in (select deal_id from public.client_access
                    where user_id = auth.uid() and enabled = true)
  );
```

**Hard rule:** always use `public.is_admin()` etc. helpers — never inline role checks.
Helpers are `SECURITY DEFINER` so they bypass RLS on `profiles`.

🧒 **What is RLS?** Imagine every row in a table has a "who can see this" sticker. RLS
(Row-Level Security) is the guard that checks the sticker before letting someone see
the row. Configured once per table; Postgres enforces every query.

---

## 7. Storage buckets

- `deal-docs` — private bucket. Stores documents, welcome videos, anything deal-scoped.
  Access via signed URLs generated at query time.
- `library` — private bucket for the Phase 3 library of reusable templates/videos.

Storage policies mirror RLS: admin + VA can upload/read all; attorney + client only paths
like `<deal_id>/*` for their assigned deals.

---

## 8. Edge Functions (Deno, Supabase)

Deploy via the Supabase CLI or the MCP `deploy_edge_function` tool. Each has a `verify_jwt`
setting — either `true` (default, expects Supabase-signed user JWT) or `false` (for
webhooks or functions that do their own auth).

| Function | verify_jwt | What it does |
|---|---|---|
| `submit-lead` | false | Receives lead-intake.html form posts. Creates a deal + texts Nathan. |
| `extract-document` | false | Claude Vision OCR of uploaded docs. Writes `documents.extracted` jsonb. |
| `send-sms` | false | Inserts into messages_outbound, then routes to Twilio or mac_bridge based on `phone_numbers.gateway`. Checks JWT manually (ES256 quirk). |
| `receive-sms` | false | Twilio webhook. Parses form-encoded post, routes via contacts.phone → contact_deals → deal, falls back to homeowner phone, then recent outbound. Unknown → messages_outbound_unmatched. |
| `twilio-voice` | false | Twilio Voice webhook. Creates call_logs row in 'ringing', returns TwiML that records + dials Nathan's iPhone. |
| `twilio-voice-status` | false | Post-call + recording callback. Final status + duration + recording URL. Missed-call auto-SMS to caller. |
| `send-email` | false | Thin Resend wrapper. From=nathan@refundlocators.com, Reply-To + Bcc = nathan@fundlocators.com. Logs to emails table. |
| `docket-webhook` | false | Castle posts scraped events here. Inserts to docket_events (or docket_events_unmatched if no matching deal). |
| `notify-walkthrough-request` | false | Called from investor-portal after submit_walkthrough_request RPC. SMSes Nathan. |
| `notify-investor-offer` | false | Similar, for investor_offers. |
| `notify-homeowner-intake` | false | SMS on homeowner intake form submit. |
| `investor-asset-url` | false | Token-gated signed URL generator for investor portal assets. |
| `get-case` | false | Lauren's case lookup for the consumer chat (pre-sign-up). |
| `generate-listing-copy` | false | Claude-generated flip listing copy from deal meta + OCR'd docs. |
| `generate-case-summary` | false | AI Case Intelligence summary. Pulls every signal on a deal, asks Claude for structured briefing, caches on deals.meta.case_intel_summary. |
| `docusign-send-envelope` | true | Sends signing envelope via DocuSign API. |
| `docusign-webhook` | true | Receives DocuSign Connect status updates. |
| `lauren-chat` | false | Consumer-facing Lauren chat (refundlocators.com). pgvector retrieval. |
| `lauren-internal` | false | DCC-side Lauren chat widget. No pgvector. |

**Secrets (set via Supabase Dashboard → Project Settings → Edge Functions):**
```
TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
ANTHROPIC_API_KEY, OPENAI_API_KEY
```

**Secrets in Vault (for SQL functions):**
```sql
select vault.create_secret('<resend-api-key>', 'resend_api_key');
```

---

## 9. The 6 HTML files

Each is a **single self-contained file**. No build step. React 18 + Babel Standalone +
Supabase JS loaded from CDN at the top:

```html
<script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
<script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>

<script type="text/babel" data-presets="env,react">
  const { useState, useEffect, useCallback, useRef } = React;
  const SUPABASE_URL = 'https://...supabase.co';
  const SUPABASE_KEY = 'sb_publishable_...';
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  // ... all component code here ...
  ReactDOM.createRoot(document.getElementById('root')).render(<App />);
</script>
```

🧒 **Why this is OK:** the publishable key is designed to be exposed — it's safe in
client code. RLS is what actually protects data. You'd never put the service-role key
here.

### 9.1 `index.html` — DCC team app
- Magic-link + password auth
- Views: Today / Pipeline / Tasks / Active / Flagged / Hygiene / Reports / Analytics / Closed
- Deal detail with 8 tabs: Overview / Comms / Docket / Contacts / Investor (flip-only) / Expenses (flip-only) / Tasks / Files
- Mobile bottom nav (5 tabs + More sheet)
- Modals: Leads / Contacts / Library / Docket / Team / Search (⌘K) / New Deal / Send Intro Text / Post Update / Walkthroughs
- Floating Lauren chat bubble (hidden on mobile; in More sheet)

### 9.2 `portal.html` — Client portal
- Magic-link auth
- Welcome video, Surplus Tracker (5-step visual), Next Milestone, Status Intel
- Messages thread with team, Documents (scrollable), Case details, Case team
- Sticky "Call Nathan" button
- Multi-claimant aware (shows count, doesn't leak emails)

### 9.3 `attorney-portal.html` — Counsel portal
- Magic-link + hash routing (#/case/:id)
- Inbox: urgency grouping (Hot/Active/Quiet/Closed) + search + filter pills
- Case detail with realtime subscriptions
- Two-tab messaging: "With RefundLocators" (private) + "With Client" (supervised)
- Unified Case Timeline (activity + docket merged)
- Post case update RPC → writes to activity with visibility=['client','team']

### 9.4 `investor-portal.html` — Token-gated investor
- URL: `?t=<token>`. Calls RPC to validate + pull deal
- Condition photos, AI-generated listing copy
- Offer form (EMD, financing_type, closing_days), walkthrough request button
- Address gated until offer submitted

### 9.5 `homeowner-intake.html` — Token-gated homeowner
- URL: `?t=<token>`. 5-step wizard
- Situation → mortgage → property basics → condition/mechanicals → finish
- Submits to `submit_homeowner_intake` RPC → merges into deals.meta.investor

### 9.6 `lead-intake.html` — Public lead form
- No auth
- UTM + referrer + landing attribution → `leads.metadata`
- Classify: surplus / preforeclosure / other
- Submits to `submit-lead` Edge Function → creates deal + texts Nathan

---

## 10. Feature inventory (DCC `index.html`)

### 10.1 Today view
- 5 stat tiles (3 for VAs): YTD Profit, Active Pipeline, Flagged, Est. Profit, Closed
- Urgency lists: overdue tasks, stale deals, bonuses owed, unfiled surplus
- Walkthroughs / Offers pending badges
- "Monthly trend" spark

### 10.2 Pipeline view (Kanban)
- Drag + drop between stages (new → texted → responded → agreement-sent → signed → filed → paid-out)
- Two tracks: surplus + 30DTS (if deal.is_30dts)
- Tier filter chips (A/B/C/other)
- County filter
- Per-card Send Intro Text button (if phone exists)

### 10.3 Tasks view
- Global across all deals, grouped by assigned_to
- Filter: overdue / today / this-week / done
- Click-through to deal

### 10.4 Deal Detail — Comms tab (the big one)
The LeadConnector-style unified thread:
- Conversation tabs across top: **👨‍👩‍👧 Everyone** (first) + per-contact + 📧 Email + 📝 Send Intro + 👥 Group + ＋ New
- Thread header: avatar, contact name, phone tel-link, from-number selector, hide-thread
- Channel filter chips: All / 💬 Messages / 📞 Calls / 📧 Email / 🔒 Internal notes
- Thread body: chronological merged feed of messages_outbound (SMS + iMessage) + call_logs (with inline `<audio>` player) + emails (expandable bubble) + deal_notes
- Composer: textarea with ⌘↵ send, send button, from-number visible on mobile
- Keyboard-safe composer via visualViewport CSS var on iOS

### 10.5 Deal Detail — Overview tab
- Case Intelligence card with AI summary + Refresh button + Equity (flip) / Surplus (surplus) tile
- Quick Notes card (compact textarea + recent 3 notes)
- Financial cards (Live P&L Waterfall for flips, Financial Summary for surplus)
- Pipeline Stage visual (surplus)
- Case Details / Deal Parameters (editable)
- Spend by Category
- Foreclosure Context (flips with case info)
- Client Portal card (surplus) / Attorney Assignment card / Welcome Video card

### 10.6 Other tabs
- **Docket** — court events fed from Castle, live + historical (backfill collapsible)
- **Contacts** — linked contacts + homeowner intake (flips) + vendors
- **Investor** (flip-only admin) — investor details editor, offers, portal share
- **Expenses** (flip-only admin) — per-category spend
- **Tasks** — per-deal task list
- **Files** — documents + notes (renamed from separate tabs)

### 10.7 Modals
- **Send Intro Text** — loads tier-matched SMS template, substitutes merge vars, sends via send-sms
- **Post Update** — writes to activity with audience selector (client + attorney)
- **Leads Modal** — triage public lead submissions, dup detection, convert to deal
- **Contacts Modal** — company-wide CRM editor
- **Library Modal** — Phase 3 reusable docs (templates, videos, links)
- **Docket Center** — scraper health + unacknowledged events

### 10.8 Mobile bottom nav
5 tabs: 📌 Today · 🧭 Pipeline · ✓ Tasks · 📁 Deals · ⋯ More (sheet with Flagged, Hygiene, Closed, Reports, Analytics, Leads, Contacts, Library, Search, Walkthroughs, Team, Sign out, Chat with Lauren)

---

## 11. Automation + scheduled jobs

### 11.1 Daily digest (pg_cron at 12:00 UTC = 8am EDT)
```sql
create or replace function public.send_daily_digest() returns void ... ;
-- Queries stale deals, urgent deadlines, unfiled surplus, bonuses owed,
-- portal activity, monthly metrics. Builds HTML email. Sends via Resend
-- to nathan@fundlocators.com (refundlocators.com has no MX).
select cron.schedule('daily-digest-nathan', '0 12 * * *', 'select public.send_daily_digest();');
```

### 11.2 Auto-task from high-signal docket events
```sql
create trigger tg_docket_event_auto_task after insert on public.docket_events
  for each row execute function public.handle_docket_auto_task();
-- disbursement_ordered → "🔔 Funds ordered — call client + ring the bell"
-- hearing_scheduled → "📅 Prep client" due 2 days before
-- objection_filed / notice_of_claim / judgment_entered → similar high-priority tasks
-- Skips is_backfill=true so historical ingestion doesn't spam.
```

### 11.3 Message notifications (team → client/attorney)
`dispatch_message_notifications` trigger on messages INSERT. Builds HTML email via
Resend when a team member sends a message; fans out to client_access + attorney_assignments
based on `audience` array.

### 11.4 Docket client notifications
`dispatch_docket_client_notifications` trigger on docket_events INSERT. Emails the
client when a non-backfill event lands on their deal.

### 11.5 Document OCR
On document insert, the UI calls `extract-document` Edge Function. It sends the file
to Claude Vision, parses typed fields (`document_type`, `confidence`, `fields` by type,
`summary`), writes to `documents.extracted` jsonb and `extraction_status`.

### 11.6 Activity log bumps staleness
`tg_bump_last_contacted` on activity INSERT watches `action` prefixes (Called/Texted/
Emailed) and updates `deals.last_contacted_at`. Used by Today view staleness ranking.

---

## 12. iMessage bridge (Mac Mini daemon)

Lives in `mac-bridge/` subdirectory of the repo. Node.js, not deployed — runs locally.

```
mac-bridge/
├── bridge.js                            # main daemon
├── package.json                         # better-sqlite3 + @supabase/supabase-js + dotenv
├── com.refundlocators.bridge.plist      # launchd agent (auto-start on login)
└── .env.example                         # SUPABASE_SERVICE_KEY
```

**What it does:**
- **Inbound:** polls `~/Library/Messages/chat.db` every 5s for new messages. Writes to `messages_outbound` with direction='inbound'.
- **Outbound:** polls Supabase for rows with `status='pending_mac'`. Sends via AppleScript → Messages.app. Updates to `sent`.

**Setup:** edit paths in the plist, `cp` to `~/Library/LaunchAgents/`, `launchctl load`
+ `start`. Grant Terminal Full Disk Access for chat.db read.

---

## 13. Castle v2 integration (scraper — separate repo)

Castle is a Python CLI that scrapes Ohio county dockets and POSTs events to DCC's
`docket-webhook` Edge Function. It lives at `refundlocators-pipeline/` (separate repo,
`github.com/TheLocatorOfFunds/castle-v2`). DCC integration points:

- `docket_events.external_id` is Castle's unique ID per event
- `scrape_runs` is Castle's heartbeat — one row per county per monitor run
- `deals.refundlocators_token` is populated by Castle when it scores a lead as A/B/C/30DTS
- Webhook body format: `{ events: [...], run_id: uuid, county: string }` with HMAC-SHA256
  signature header

---

## 14. Lauren (AI assistant) — three flavors

1. **Consumer-facing** (refundlocators.com) — floating chat widget, pgvector retrieval on
   ORC statutes + county rules. Edge Function: `lauren-chat`.
2. **DCC-internal chat** — bubble in DCC team app, answers Nathan's questions. Edge
   Function: `lauren-internal`.
3. **Operational agent** (planned, per LAUREN_AGENT_CHARTER.md) — separate Claude Code
   session with tool-use: find_deal / send_sms / send_email / log_activity / query_dcc /
   ask_confirmation. Phase-gated; not yet built.

All three share `lauren_knowledge` (the pgvector store) and
`lauren_conversations` (multi-turn audit log).

---

## 15. Deployment flow

```bash
# One-time: clone repo, link to Supabase project, enable Pages
git clone https://github.com/<username>/deal-command-center.git
supabase link --project-ref rcfaashkfpurkvtmsmeb

# Dev loop: edit, preview, ship
open index.html                           # file:// works for local testing — auth + Supabase work
# (or run a tiny Python http.server if you need the file served over HTTP)
git commit -am "describe change"
git push                                  # ~30s later: live at your Pages URL
```

**Migrations:**
```bash
ls supabase/migrations/                   # find latest timestamp
# Create new file YYYYMMDDHHMMSS_name.sql (increment by 1s)
# Write SQL. Commit.
# Apply via Supabase SQL editor or `supabase db push` if you set up local Supabase
```

**Edge Functions:**
```bash
# Via Supabase CLI:
supabase functions deploy <name> --no-verify-jwt
# Or via MCP's deploy_edge_function tool (programmatic)
```

---

## 16. Known gotchas

- **Babel in the browser is slow on cold load** (~1s). That's Babel parsing ~500KB of JSX.
  Normal, not broken.
- **No TypeScript, no linter.** Typos surface at runtime in the browser console.
- **`meta` jsonb is a grab-bag.** Document new fields here or in CLAUDE.md.
- **Status strings are lowercase-hyphenated:** `new-lead`, `under-contract`. Don't change
  casing without updating `STATUS_COLORS` and seed data.
- **Deal IDs are text, not uuid.** Patterns: `sf-<lastname>` for surplus,
  `flip-<streetnumber>` for flips. Some legacy ones: `flip-2533`, `sf-caldwell`.
- **`activity` is write-heavy.** Every edit logs. Don't bulk-edit without batching.
- **refundlocators.com has no MX records.** Any outbound to `nathan@refundlocators.com`
  bounces. Use `nathan@fundlocators.com` (Google Workspace) for real inbound mail.
  Cloudflare Email Routing is the fix; blocked today by apex proxied CNAME.
- **pg_cron runs in UTC.** 12:00 UTC = 8am EDT (7am EST).
- **The Supabase publishable key is safe in HTML.** The service-role key is NOT — never
  embed it in client code. It goes only in Edge Function secrets or the Vault.
- **Twilio trial mode blocks unverified recipients.** Upgrade out of trial before real
  outreach.
- **DocuSign webhooks** need to be registered on Connect as an URL; DocuSign retries on
  5xx.

---

## 17. Build order for a fresh session

If rebuilding from zero, do in this order:

1. §3 external services (GitHub, Supabase, Resend, Twilio, Anthropic, OpenAI, Cloudflare)
2. §5 database schema — tables + indexes + constraints. No RLS yet.
3. §4 + §6 auth + RLS — roles, helpers, policies
4. §5.8 Lauren tables (optional for MVP — skip until needed)
5. §7 storage buckets + policies
6. §9 HTML files — start with index.html skeleton (shell + auth) and portal.html
7. §10 feature inventory — build Overview + Comms first; they're the hero
8. §8 Edge Functions — submit-lead, send-sms, receive-sms, extract-document first
9. §11 automation + cron
10. §12 iMessage bridge (optional, Mac Mini needed)
11. §13 Castle integration (pipeline repo lives separately)

**Minimum viable DCC** = §3–§10 without investor/homeowner/library portals. You can ship
the team app + client portal + lead intake + attorney portal in ~1 week of focused work.

---

## 18. For a fresh Claude Code session

If you're a new session reading this cold:

**Your job:** rebuild DCC from this spec. Nothing else.

**Before writing any code:**
- Read §1 + §2 for the big picture
- Skim §3-§5 for services + schema
- Read §9-§10 for what the UI actually does
- Check §16 for the landmines

**When writing code:**
- One file per portal (§9). Don't introduce a build step.
- Use the `is_admin()` / `is_va()` / `is_attorney()` / `is_client()` helpers in every RLS
  policy — never inline role checks
- Keep `meta` jsonb as a grab-bag; add new fields there before adding columns
- Every migration file has a `YYYYMMDDHHMMSS_name.sql` timestamp, incrementing by 1s
- Commit to `main` = ship. No staging.

**When stuck:**
- The canonical Supabase project is `rcfaashkfpurkvtmsmeb`. Poke at the schema there if
  you have access; it's the source of truth.
- Read `CLAUDE.md` in this repo for operator-level guidance.
- Read `LAUREN_AGENT_CHARTER.md` if you're asked to build Lauren.
- Read `LEAD_FUNNEL_2WEEK_PLAN.md` for the current execution plan.

---

*End of recreation spec. This document is version-controlled — commit updates as the
system evolves.*
