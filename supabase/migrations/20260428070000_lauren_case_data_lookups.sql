-- Lauren read-tools: deal detail, deal notes, docket events.
--
-- Per Nathan 2026-04-28: he wants to ask Lauren things like "go read
-- Richard's notes and the docket and fill in sale price / sale date /
-- judgment debt." She already has propose_update_deal_meta to write,
-- and recent_activity for the activity log — but no way to read
-- deal_notes or docket_events directly. These three RPCs fill that gap.
--
-- All three are SECURITY DEFINER + admin-gated via is_admin() so the
-- Edge Function can call them under the user's JWT and they bypass the
-- normal RLS for read access without leaking data to non-admins.

-- 1. Full deal record incl. current meta. Saves Lauren a tool call when
--    she needs to know what's already populated before proposing an
--    update.
create or replace function public.lauren_get_deal_detail(p_deal_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
begin
  if not (public.is_admin() or public.is_va()) then
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
grant execute on function public.lauren_get_deal_detail(text) to authenticated, service_role;

-- 2. Recent deal_notes — the team's free-text notes on a deal. Used
--    when Lauren needs to extract structured facts from the
--    "everyone-types-into-this" history.
create or replace function public.lauren_lookup_deal_notes(p_deal_id text, p_limit int default 10)
returns table(title text, body text, author text, created_at timestamptz)
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
    and (public.is_admin() or public.is_va())
  order by n.created_at desc
  limit p_limit;
$$;
grant execute on function public.lauren_lookup_deal_notes(text, int) to authenticated, service_role;

-- 3. Recent docket_events — court events Castle has scraped. This is
--    where things like "Confirmation of Sale", "Judgment Entry", and
--    sale-price line items live in Cuyahoga / Butler / Franklin /
--    Montgomery cases.
create or replace function public.lauren_lookup_docket_events(p_deal_id text, p_limit int default 30)
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
    and (public.is_admin() or public.is_va())
  order by e.event_date desc nulls last, e.received_at desc nulls last
  limit p_limit;
$$;
grant execute on function public.lauren_lookup_docket_events(text, int) to authenticated, service_role;
