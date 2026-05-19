-- ─────────────────────────────────────────────────────────────────────
-- 20260516120100_global_search_pg_trgm
--
-- Backs the mobile global search feature. Installs pg_trgm + GIN indexes
-- across 6 searchable entities, then exposes a single `global_search(q,
-- max_per_kind)` RPC that returns UNIONED ranked results.
--
-- See docs/MOBILE_GLOBAL_SEARCH.md for design context.
-- ─────────────────────────────────────────────────────────────────────

create extension if not exists pg_trgm;

-- ─── GIN trigram indexes ─────────────────────────────────────────────
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

-- ─── RPC: global_search ──────────────────────────────────────────────
create or replace function public.global_search(q text, max_per_kind int default 5)
returns table (
  kind     text,
  id       text,
  deal_id  text,
  title    text,
  snippet  text,
  rank     real
)
language plpgsql
security invoker     -- RLS applies; users see only what they're allowed
set search_path = public
as $$
declare
  v_q text := lower(trim(coalesce(q, '')));
  v_ilike text := '%' || v_q || '%';
begin
  if length(v_q) < 2 then
    return;
  end if;

  return query
  -- DEALS
  (
    select 'deal'::text, d.id::text, d.id::text,
           coalesce(d.name, '(no name)')::text,
           (coalesce(d.address, '') || ' · ' || coalesce(d.meta->>'attorney',''))::text,
           similarity(
             lower(coalesce(d.name,'') || ' ' || coalesce(d.address,'') || ' ' || coalesce(d.meta->>'courtCase','')),
             v_q
           ) as rank
      from public.deals d
     where (
       coalesce(d.name,'') || ' ' || coalesce(d.address,'') || ' ' ||
       coalesce(d.meta->>'courtCase','') || ' ' || coalesce(d.meta->>'county','') || ' ' ||
       coalesce(d.meta->>'attorney','')
     ) ilike v_ilike
     order by rank desc nulls last
     limit max_per_kind
  )
  union all
  -- NOTES
  (
    select 'note'::text, n.id::text, n.deal_id::text,
           coalesce(n.title, '(note)')::text,
           substring(coalesce(n.body,'') from 1 for 120)::text,
           similarity(lower(coalesce(n.title,'') || ' ' || coalesce(n.body,'')), v_q)
      from public.deal_notes n
     where (coalesce(n.title,'') || ' ' || coalesce(n.body,'')) ilike v_ilike
     order by rank desc nulls last
     limit max_per_kind
  )
  union all
  -- CONTACTS
  (
    select 'contact'::text, c.id::text, null::text,
           coalesce(c.name, '(contact)')::text,
           (coalesce(c.company,'') || ' · ' || coalesce(c.phone,''))::text,
           similarity(lower(coalesce(c.name,'') || ' ' || coalesce(c.company,'') || ' ' || coalesce(c.email,'') || ' ' || coalesce(c.phone,'')), v_q)
      from public.contacts c
     where (coalesce(c.name,'') || ' ' || coalesce(c.company,'') || ' ' || coalesce(c.email,'') || ' ' || coalesce(c.phone,'')) ilike v_ilike
     order by rank desc nulls last
     limit max_per_kind
  )
  union all
  -- VENDORS
  (
    select 'vendor'::text, v.id::text, v.deal_id::text,
           coalesce(v.name, '(vendor)')::text,
           (coalesce(v.role,'') || ' · ' || coalesce(v.phone,''))::text,
           similarity(lower(coalesce(v.name,'') || ' ' || coalesce(v.role,'') || ' ' || coalesce(v.phone,'') || ' ' || coalesce(v.email,'')), v_q)
      from public.vendors v
     where (coalesce(v.name,'') || ' ' || coalesce(v.role,'') || ' ' || coalesce(v.phone,'') || ' ' || coalesce(v.email,'')) ilike v_ilike
     order by rank desc nulls last
     limit max_per_kind
  )
  union all
  -- MESSAGES (recent 30 days only)
  (
    select 'message'::text, m.id::text, m.deal_id::text,
           '(SMS)'::text,
           substring(coalesce(m.body,'') from 1 for 120)::text,
           similarity(lower(coalesce(m.body,'')), v_q)
      from public.messages_outbound m
     where m.created_at > now() - interval '30 days'
       and coalesce(m.body,'') ilike v_ilike
     order by rank desc nulls last
     limit max_per_kind
  )
  union all
  -- TEAM MESSAGES
  (
    select 'team_msg'::text, t.id::text, null::text,
           '(team chat)'::text,
           substring(coalesce(t.body,'') from 1 for 120)::text,
           similarity(lower(coalesce(t.body,'')), v_q)
      from public.team_messages t
     where coalesce(t.body,'') ilike v_ilike
     order by rank desc nulls last
     limit max_per_kind
  );
end;
$$;

grant execute on function public.global_search(text, int) to authenticated;

comment on function public.global_search(text, int) is
  'Single-query global search across deals, deal_notes, contacts, vendors, messages_outbound (last 30 days), team_messages. Returns top-N per entity, ranked by trigram similarity. Backed by pg_trgm GIN indexes for sub-50ms lookups. See docs/MOBILE_GLOBAL_SEARCH.md.';
