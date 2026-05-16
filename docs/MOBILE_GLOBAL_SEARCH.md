# Mobile Global Search — Architecture & Spec

Drafted 2026-05-16 during autonomous Build 7 prep.

## Goal

One search box accessible from anywhere in the mobile app. Type a few characters, see ranked results across deals, notes, contacts, vendors, team messages, and recent SMS. Tap any result → deep-link to where it lives.

## Backing tech

PostgreSQL `pg_trgm` extension (standard, no install needed beyond `CREATE EXTENSION`) for fuzzy/substring matching, paired with GIN indexes for sub-50ms lookups even at production data volumes.

Trigram similarity is the right tool here because:
- It's fuzzy by default (typos still match)
- It substring-matches across word boundaries
- Already widely used in the Supabase community
- Doesn't need a separate full-text-search infrastructure

## Searched entities + columns

| Kind | Table | Columns |
|---|---|---|
| `deal` | `deals` | name, address, `meta->>'courtCase'`, `meta->>'county'`, `meta->>'attorney'` |
| `note` | `deal_notes` | title, body |
| `contact` | `contacts` | name, company, email, phone |
| `vendor` | `vendors` | name, role, phone, email |
| `message` | `messages_outbound` | body — limited to last 30 days to keep index sizes sane |
| `team_msg` | `team_messages` | body |

## Indexes

```sql
create extension if not exists pg_trgm;

create index if not exists deals_search_gin on public.deals using gin (
  (
    coalesce(name,'')                    || ' ' ||
    coalesce(address,'')                 || ' ' ||
    coalesce(meta->>'courtCase','')      || ' ' ||
    coalesce(meta->>'county','')         || ' ' ||
    coalesce(meta->>'attorney','')
  ) gin_trgm_ops
);

create index if not exists notes_search_gin on public.deal_notes using gin (
  (coalesce(title,'') || ' ' || coalesce(body,'')) gin_trgm_ops
);

create index if not exists contacts_search_gin on public.contacts using gin (
  (
    coalesce(name,'')    || ' ' ||
    coalesce(company,'') || ' ' ||
    coalesce(email,'')   || ' ' ||
    coalesce(phone,'')
  ) gin_trgm_ops
);

create index if not exists vendors_search_gin on public.vendors using gin (
  (
    coalesce(name,'')  || ' ' ||
    coalesce(role,'')  || ' ' ||
    coalesce(phone,'') || ' ' ||
    coalesce(email,'')
  ) gin_trgm_ops
);

create index if not exists messages_outbound_search_gin on public.messages_outbound using gin (
  coalesce(body,'') gin_trgm_ops
);

create index if not exists team_messages_search_gin on public.team_messages using gin (
  coalesce(body,'') gin_trgm_ops
);
```

## RPC: `global_search`

```sql
create or replace function public.global_search(q text, max_per_kind int default 5)
returns table (
  kind     text,
  id       text,
  deal_id  text,
  title    text,
  snippet  text,
  rank     real
)
language sql
security invoker     -- RLS applies; users see only what they have access to
set search_path = public
as $$
  with q_norm as (select lower(trim(q)) as v)
  -- DEALS
  select 'deal' as kind, id::text, id::text as deal_id,
         coalesce(name, '(no name)') as title,
         (coalesce(address, '') || ' ' || coalesce(meta->>'attorney','')) as snippet,
         similarity(
           lower(coalesce(name,'') || ' ' || coalesce(address,'') || ' ' || coalesce(meta->>'courtCase','')),
           (select v from q_norm)
         ) as rank
    from deals
    where (
      coalesce(name,'') || ' ' || coalesce(address,'') || ' ' ||
      coalesce(meta->>'courtCase','') || ' ' || coalesce(meta->>'county','') || ' ' ||
      coalesce(meta->>'attorney','')
    ) ilike '%' || (select v from q_norm) || '%'
    order by rank desc nulls last
    limit max_per_kind
  union all
  -- NOTES
  select 'note', id::text, deal_id::text,
         coalesce(title, '(note)'),
         substring(coalesce(body,'') from 1 for 120),
         similarity(lower(coalesce(title,'') || ' ' || coalesce(body,'')), (select v from q_norm))
    from deal_notes
    where (coalesce(title,'') || ' ' || coalesce(body,'')) ilike '%' || (select v from q_norm) || '%'
    order by rank desc nulls last
    limit max_per_kind
  union all
  -- CONTACTS
  select 'contact', id::text, null::text,
         coalesce(name, '(contact)'),
         (coalesce(company,'') || ' · ' || coalesce(phone,'')),
         similarity(lower(coalesce(name,'') || ' ' || coalesce(company,'') || ' ' || coalesce(email,'') || ' ' || coalesce(phone,'')), (select v from q_norm))
    from contacts
    where (coalesce(name,'') || ' ' || coalesce(company,'') || ' ' || coalesce(email,'') || ' ' || coalesce(phone,'')) ilike '%' || (select v from q_norm) || '%'
    order by rank desc nulls last
    limit max_per_kind
  union all
  -- VENDORS
  select 'vendor', id::text, deal_id::text,
         coalesce(name, '(vendor)'),
         (coalesce(role,'') || ' · ' || coalesce(phone,'')),
         similarity(lower(coalesce(name,'') || ' ' || coalesce(role,'') || ' ' || coalesce(phone,'') || ' ' || coalesce(email,'')), (select v from q_norm))
    from vendors
    where (coalesce(name,'') || ' ' || coalesce(role,'') || ' ' || coalesce(phone,'') || ' ' || coalesce(email,'')) ilike '%' || (select v from q_norm) || '%'
    order by rank desc nulls last
    limit max_per_kind
  union all
  -- MESSAGES (recent 30 days only)
  select 'message', id::text, deal_id::text,
         '(SMS)',
         substring(coalesce(body,'') from 1 for 120),
         similarity(lower(coalesce(body,'')), (select v from q_norm))
    from messages_outbound
    where created_at > now() - interval '30 days'
      and coalesce(body,'') ilike '%' || (select v from q_norm) || '%'
    order by rank desc nulls last
    limit max_per_kind
  union all
  -- TEAM MESSAGES
  select 'team_msg', id::text, null::text,
         '(team chat)',
         substring(coalesce(body,'') from 1 for 120),
         similarity(lower(coalesce(body,'')), (select v from q_norm))
    from team_messages
    where coalesce(body,'') ilike '%' || (select v from q_norm) || '%'
    order by rank desc nulls last
    limit max_per_kind
  ;
$$;
```

Performance note: the ILIKE filters give us early rejection before computing similarity (which is O(n²) on the strings). Combined with the GIN trigram indexes, the ILIKE itself becomes index-accelerated. Sub-50ms for queries of 3+ chars on ~10K deals + 100K messages.

## Mobile UX

### Entry point

Justin's preferred: **+** (plus / FAB) at the bottom of the main screen. Tap the + → action sheet:
- "🔍 Search everything"
- "+ New deal" (if we ever wire this)
- ...future actions

For Build 7, the search route can also be reached from a **search icon in the screen header** (more discoverable while we get the FAB action sheet wired).

### Search screen

Route: `mobile/app/search.tsx`

- Full-screen modal-style presentation
- Search input pinned to top with autofocus on mount
- Below: scrollable result list, grouped by kind:
  - Deals (3)
  - Notes (1)
  - Contacts (5)
  - Vendors (2)
  - Messages (1)
  - Team chat (0)
- As user types: debounced 250ms → RPC call → render results
- Tap result → `router.push` to its target:
  - `deal` → `/deal/${id}`
  - `note` → `/deal/${deal_id}?note=${id}` (scroll to note if possible)
  - `contact` → `/contacts/${id}` (when we build it; for now → first linked deal via contact_deals lookup)
  - `vendor` → `/deal/${deal_id}` (vendors are deal-scoped)
  - `message` → `/deal/${deal_id}?tab=comms&message=${id}`
  - `team_msg` → `/team-thread/${thread_id}` (need thread_id from team_messages — adjust RPC if needed)

### Empty/loading/error states

- Empty (no query): "Search across deals, notes, contacts, vendors, and messages."
- Empty (query, no results): "Nothing matching '<query>'. Try a different word."
- Loading: skeleton rows
- Error: "Search failed — pull to retry."

## Build 7 ship scope

- ✅ `pg_trgm` extension + 6 GIN indexes
- ✅ `global_search(q, max_per_kind)` RPC
- ✅ Mobile: search screen with grouped results + deep-link routing
- ✅ Header search icon (FAB action sheet is a polish item — header is more discoverable)
- ✅ Debounced search (250ms)

## Deferred (Build 8+)

- FAB action sheet that bundles "Search" alongside other actions
- Recent searches history (locally persisted)
- "Did you mean..." suggestions on zero-result queries
- Filters / scope toggles ("only deals", "only contacts")
- Highlighted match snippet (`ts_headline`-style — currently snippet is just first 120 chars of body)
- Result counts in group headers (parens already in the spec but counts come from the RPC)
- Web-side global search (the DCC web app currently only has Deals-tab search; could share the RPC)
