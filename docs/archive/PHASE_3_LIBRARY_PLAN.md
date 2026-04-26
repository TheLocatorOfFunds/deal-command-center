# Phase 3 — Company-Wide Document Library

**Goal**: replace Google Drive as the home for every non-deal-scoped document the company produces — SOPs, contracts, legal templates, brand assets, training videos, playbooks, engagement letters, attorney letters, intake scripts. One login, one place, one search bar.

**Where this fits**: Phase 3 of the 8-phase Business OS roadmap in `TRANSFER_TO_NEW_CLAUDE_CODE.md` §16. Phase 2 (Contacts/CRM) is complete as of Session 14. Phase 3 is the next natural build once Nathan confirms Phase 2 is holding up in daily use.

**Status**: Design proposal. No code or migrations applied.

---

## 1 — What's different from the existing `documents` table

The current `documents` table is **per-deal** — every row has a required `deal_id`. That's the right shape for case files (a W-9 attached to Kemper's case belongs with Kemper's case). But it doesn't work for:

- The **standard intake SOP** that applies to every surplus lead
- The **blank attorney engagement letter template** the team copies for each new attorney retention
- The **brand guide PDF** every VA needs on day one
- The **refundlocators.com hero video** that gets embedded on multiple client portals
- The **Q1 2026 marketing deck** Nathan showed investors
- The **office LLC operating agreement** that isn't tied to any deal

Phase 3 adds a **second, parallel system**: a `library_documents` table whose rows are NOT tied to a deal. Files live in a new `library` storage bucket. The existing `deal-docs` bucket keeps doing what it does today — nothing changes there.

---

## 2 — Tables (migration sketch)

```sql
create table public.library_folders (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  parent_id   uuid references public.library_folders(id) on delete cascade,
  visibility  text not null default 'team',  -- 'admin_only' | 'team' | 'attorney' | 'client'
  sort_order  int  not null default 0,
  created_at  timestamptz default now(),
  created_by  uuid references auth.users(id)
);

create table public.library_documents (
  id              uuid primary key default gen_random_uuid(),
  folder_id       uuid references public.library_folders(id) on delete set null,
  title           text not null,
  description     text,
  path            text not null,                         -- key in `library` storage bucket
  size            bigint,
  mime_type       text,
  kind            text not null default 'file',          -- 'file' | 'template' | 'video' | 'image' | 'link'
  external_url    text,                                   -- for kind='link' (e.g. a Loom)
  tags            text[] not null default '{}',
  version         int  not null default 1,
  supersedes_id   uuid references public.library_documents(id) on delete set null,
  visibility      text not null default 'team',          -- same enum as folders; document overrides folder
  is_pinned       boolean default false,                  -- shows at top of folder
  extracted       jsonb,                                   -- OCR result (reuse Phase-1 extract-document fn)
  extraction_status text,
  owner_id        uuid references auth.users(id) on delete set null,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

create table public.library_document_contacts (
  id           uuid primary key default gen_random_uuid(),
  document_id  uuid not null references public.library_documents(id) on delete cascade,
  contact_id   uuid not null references public.contacts(id) on delete cascade,
  relation     text,
  unique (document_id, contact_id)
);
```

**Indexes**: `folder_id`, `tags` (gin), `lower(title)`, `supersedes_id`.

**Storage bucket**: `library` — private, RLS-gated. Follows the existing `deal-docs` pattern for signed URLs.

**Realtime**: publish `library_folders`, `library_documents` on `supabase_realtime` so multiple admins editing the same folder see updates live.

---

## 3 — Permissions (visibility model)

Four levels, stored as an enum string on both folders and documents. Document-level overrides folder-level.

| Visibility  | Admin | VA   | Attorney                           | Client                             |
|-------------|-------|------|------------------------------------|------------------------------------|
| `admin_only`| ✓     | ✗    | ✗                                  | ✗                                  |
| `team`      | ✓     | ✓    | ✗                                  | ✗                                  |
| `attorney`  | ✓     | ✓    | only if linked to one of their assigned deals via `library_document_contacts` or a per-deal `deal_library_pins` table (deferred) | ✗ |
| `client`    | ✓     | ✓    | same as `attorney`                 | only via an explicit `deal_library_pins` row the admin attaches to their deal |

**MVP simplification**: ship with `admin_only` + `team` only. Attorney/client visibility layer comes in a follow-up once we see real usage patterns — premature abstraction otherwise.

RLS policies:
```sql
-- Simplest two-tier starting point
create policy library_admin_all_docs on public.library_documents for all
  using (public.is_admin()) with check (public.is_admin());

create policy library_va_read_team_docs on public.library_documents for select
  using (public.is_va() and visibility in ('team'));

create policy library_va_write_team_docs on public.library_documents for insert
  with check (public.is_va() and visibility = 'team');

-- Same pattern for library_folders.
```

---

## 4 — UI surfaces (in DCC)

### Top-level "📚 Library" button in the header
Next to Contacts. Opens a `LibraryModal`.

### LibraryModal
Three-pane layout on desktop, stacked on mobile:
- **Left** — folder tree (nested, drag-to-reorder later)
- **Middle** — list of docs in the selected folder (or search results). Each row: title, kind icon, tags, last updated, owner
- **Right** — doc preview / metadata panel when a doc is selected

Actions:
- **New folder** (admin)
- **Upload** — multi-file drop, auto-assigns to current folder
- **New from template** — if the selected doc has `kind='template'`, a button creates a copy into a deal's `documents` bucket with one click
- **Supersede** — replace a doc with a new version; old version stays as `supersedes_id` history
- **Pin to deal** (deferred — `deal_library_pins` table)

### LibraryPicker (reusable)
Embedded inside DealDetail. Lets Nathan pin a library doc to a specific deal without copying the file. Writes to `deal_library_pins` table. Client/attorney portals then render pinned library docs alongside deal-scoped documents. (Deferred MVP to keep the first cut focused.)

---

## 5 — Search + OCR

Reuse the existing `extract-document` Edge Function unchanged. On upload, extract text into `library_documents.extracted` jsonb. Frontend search then hits:
- `title ilike`
- `description ilike`
- `tags && array[…]`
- full-text search on `extracted->>'summary'` + `extracted->>'body'`

Later: Postgres full-text index or a `tsvector` generated column.

---

## 6 — First three PRs (sequence)

1. **Foundation migration + empty Library modal.** Ship the tables + RLS + bucket + a library button that opens an empty three-pane modal reading the (empty) tables. No uploads yet. Proves the wiring.
2. **Upload + folder tree + list.** Add upload, folder create/rename/move, basic list with search. OCR runs on upload (reuses the Edge Function). Two-tier visibility only (admin_only / team).
3. **Template cloning + Library picker embedded in DealDetail.** Add the `kind='template'` + "Use this template on this deal" action that copies a library file into the deal's `deal-docs` bucket and creates a `documents` row. Also add `deal_library_pins` + rendering in client portal.

Each PR should be independently shippable and independently testable. No big-bang.

---

## 7 — Dependencies on earlier phases

- **Phase 2 (Contacts/CRM)** is a soft dep — `library_document_contacts` lets you say "this template was authored by Jeff Kainiz, attorney" or "this contract template is for our relationship with Title Co X". Not blocking; can ship the library without it and add the link table later.
- **Existing `extract-document` Edge Function** — reuse, no changes.
- **Supabase Vault + Resend** — unchanged. Library itself doesn't send email.

---

## 8 — Design questions — CONFIRMED by Nathan (Session 17, 2026-04-20)

Nathan confirmed "yes to all of the 5 open phase 3 questions, i am good with your rec." Locked-in answers below. Build accordingly.

1. **Versioning — CONFIRMED: keep visible.** Old versions stay in a history drawer on each doc, with "latest" pinned to the top. Good for forensics and audit trails.
2. **External links — CONFIRMED: first-class `kind='link'`.** Supports Loom, Notion, YouTube, any URL. Renders in the library list alongside uploaded files.
3. **Upload rights — CONFIRMED: VAs can upload into `team` folders; admins-only for `admin_only` folders.** Matches DCC's existing role-gating pattern.
4. **Seed folders on day 1 — CONFIRMED:**
   - `01 — Brand (cream/navy/gold, logos, icons, typography)`
   - `02 — Templates (engagement letters, attorney retainer, fee disclosure, W-9)`
   - `03 — SOPs (intake, attorney kickoff, post-recovery handoff, VA day-one)`
   - `04 — Legal (LLC docs, DBAs, insurance, 1099s)`
   - `05 — Marketing (refundlocators assets, defenderha assets, fundlocators SEO)`
   - `06 — Training (Loom walkthroughs, onboarding videos)`
   - `07 — Financial (admin-only — monthly P&L exports, tax docs)`
5. **Client portal integration — CONFIRMED: pin-per-deal only.** `visibility='client'` docs do NOT auto-appear in every portal. They only show up in a client's portal after an admin explicitly pins them to that deal (via the deferred `deal_library_pins` table in PR 3). Protects against accidental cross-deal leakage.

---

## 9 — Effort estimate

Rough sizing in "Nathan-prompts, Claude-executes" sessions:

- **PR 1** (tables + empty modal): ~1 session (~1-2 hours real time)
- **PR 2** (upload, folders, list, search, OCR): ~1.5 sessions
- **PR 3** (templates + deal pinning + client portal surfacing): ~1.5 sessions

Total: **~3-4 sessions to replace Google Drive for 80% of RefundLocators' document needs.** The other 20% (image-heavy marketing folders, Loom trees, historical deep archive) can stay in Google Drive forever or migrate gradually.

---

## 10 — Why this matters for the sell-the-business vision

Per §16 of the transfer doc, Nathan's endgame is *"one login, everything, sellable"*. Of all the Business OS phases, the Library has the biggest compounding effect:

- Every SOP that lives in DCC is an asset a new hire or buyer can onboard from day one
- Every template is a cost-savings (no hunting Google Drive)
- Every historical contract is a due-diligence artifact
- When you hand over the one login, the library **is** the institutional memory

This is the phase that turns DCC from "tool" into "business itself". Worth taking the time to ship it clean.

— End of Phase 3 plan.
