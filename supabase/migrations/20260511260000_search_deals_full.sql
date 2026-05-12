-- Full-text-ish search across deals + their meta jsonb. The mobile
-- Deals tab uses this so a search for "Morrow" or "Clark" or
-- "23 CV 0836" hits the right deals even though those values live in
-- `meta.homeownerName`, `meta.county`, `meta.courtCase` etc.
--
-- Trade-off: scanning meta as text is slower than a structured index,
-- but at the scale of a few hundred deals it's still <10ms.

create or replace function public.search_deals_mobile(p_query text)
returns table (
  id text,
  type text,
  status text,
  name text,
  address text,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with q as (
    select '%' || lower(replace(replace(p_query, '%', ''), '_', '')) || '%' as needle
  )
  select d.id, d.type, d.status, d.name, d.address, d.updated_at
  from public.deals d, q
  where (
    lower(coalesce(d.name, ''))            like q.needle
    or lower(coalesce(d.address, ''))      like q.needle
    or lower(d.id)                          like q.needle
    or lower(coalesce(d.meta::text, '{}'))  like q.needle
  )
  order by d.updated_at desc nulls last
  limit 50
$$;

comment on function public.search_deals_mobile is
  'Mobile Deals tab search. Matches name/address/id plus a substring '
  'match against the raw meta jsonb text, so homeownerName, county, '
  'courtCase, etc. are all reachable from a single input.';

grant execute on function public.search_deals_mobile(text)
  to authenticated, service_role;
