-- Same admin/VA gate bug as the get_deal_url fix in
-- 20260528200534_lauren_get_deal_url_service_role_bypass.sql, except
-- this one was hiding in three other lauren_* RPCs that Lauren's
-- tool dispatch calls all the time:
--
--   lauren_get_deal_detail        - tool: get_deal_detail
--   lauren_lookup_deal_notes      - tool: lookup_deal_notes
--   lauren_lookup_docket_events   - tool: lookup_docket_events
--
-- All three are short-circuited on (is_admin() or is_va()) which is
-- false when called from service_role (auth.uid() is NULL). The EF was
-- receiving NULL on every call, and Lauren has likely been
-- hallucinating the responses for any "go read the docket and fill in
-- sale price / sale date / judgment debt" type workflow as a result.
--
-- Same fix as the get_deal_url one: let service_role through. The
-- lauren-team-respond EF already authorizes its callers in authorize()
-- (shared secret OR admin/VA JWT), so this is no security regression.
--
-- Discovered while QA-testing get_deal_url 2026-05-28.

create or replace function public.lauren_get_deal_detail(p_deal_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
begin
  if auth.role() is distinct from 'service_role'
     and not (public.is_admin() or public.is_va()) then
    return null;
  end if;
  select id, name, address, status, type, meta, owner_id, created_at, updated_at
    into v_row
  from public.deals
  where id = p_deal_id;
  if not found then return null; end if;
  return jsonb_build_object(
    'id',         v_row.id,
    'name',       v_row.name,
    'address',    v_row.address,
    'status',     v_row.status,
    'type',       v_row.type,
    'meta',       v_row.meta,
    'created_at', v_row.created_at,
    'updated_at', v_row.updated_at
  );
end;
$$;

create or replace function public.lauren_lookup_deal_notes(p_deal_id text, p_limit integer default 10)
returns table(title text, body text, author text, created_at timestamp with time zone)
language sql
security definer
set search_path = public
as $$
  select
    n.title,
    n.body,
    coalesce(p.name, 'Team') as author,
    n.created_at
  from public.deal_notes n
  left join public.profiles p on p.id = n.author_id
  where n.deal_id = p_deal_id
    and (auth.role() = 'service_role' or public.is_admin() or public.is_va())
  order by n.created_at desc
  limit p_limit;
$$;

create or replace function public.lauren_lookup_docket_events(p_deal_id text, p_limit integer default 30)
returns table(event_date date, event_type text, description text, source text)
language sql
security definer
set search_path = public
as $$
  select
    e.event_date,
    e.event_type,
    e.description,
    e.source
  from public.docket_events e
  where e.deal_id = p_deal_id
    and (auth.role() = 'service_role' or public.is_admin() or public.is_va())
  order by e.event_date desc nulls last, e.received_at desc nulls last
  limit p_limit;
$$;
