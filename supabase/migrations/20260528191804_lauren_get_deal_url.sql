-- Lauren `get_deal_url` tool - backing RPC.
--
-- When a user asks Lauren "show me the case" / "give me the link" / "go to X"
-- she calls this after lookup_deal to get a clickable URL.
--
-- URL resolution order:
--   1. meta.intel_main_url - canonical, written by intel-main's sync (319 of 432
--      live deals have this as of 2026-05-28).
--   2. Constructed from base + meta.intel_case_id when the URL itself was
--      somehow not pushed but the case_id is set (1 deal at last check).
--   3. DCC hash-route fallback (https://app.refundlocators.com/#/deal/<id>) -
--      so deals that haven't been pushed to Castle yet still get a useful link.
--      `in_castle` is false in that branch so Lauren can word the reply
--      accurately ("no Castle case yet, here's the DCC view").
--
-- Gated to admins + VAs via the standard helper, matching every other
-- lauren_* read RPC (lauren_get_deal_detail, lauren_lookup_deal_notes, …).

create or replace function public.lauren_get_deal_url(p_deal_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row         record;
  v_castle_base text := 'https://main-intel.vercel.app';
  v_dcc_base    text := 'https://app.refundlocators.com';
  v_intel_url   text;
  v_intel_case  text;
  v_label       text;
  v_url         text;
  v_in_castle   boolean := false;
begin
  if not (public.is_admin() or public.is_va()) then
    return null;
  end if;

  select id, name, address, meta
    into v_row
  from public.deals
  where id = p_deal_id
    and deleted_at is null;
  if not found then
    return jsonb_build_object('error', 'deal not found', 'deal_id', p_deal_id);
  end if;

  v_intel_url  := nullif(trim(v_row.meta->>'intel_main_url'), '');
  v_intel_case := nullif(trim(v_row.meta->>'intel_case_id'),  '');
  v_label      := coalesce(nullif(trim(v_row.name), ''),
                           nullif(trim(v_row.address), ''),
                           v_row.id);

  if v_intel_url is not null then
    v_url := v_intel_url;
    v_in_castle := true;
  elsif v_intel_case is not null then
    v_url := v_castle_base || '/case/' || v_intel_case;
    v_in_castle := true;
  else
    -- DCC hash-route fallback. Mirrors src/app.jsx routing
    -- (window.location.hash = `#/deal/${dealId}/${tab}`).
    v_url := v_dcc_base || '/#/deal/' || v_row.id;
    v_in_castle := false;
  end if;

  return jsonb_build_object(
    'url',       v_url,
    'deal_id',   v_row.id,
    'label',     v_label,
    'in_castle', v_in_castle
  );
end;
$$;

revoke all on function public.lauren_get_deal_url(text) from public;
grant execute on function public.lauren_get_deal_url(text) to authenticated, service_role;

comment on function public.lauren_get_deal_url(text) is
  'Returns the best clickable URL for a deal - Castle (intel-main) when synced, DCC fallback otherwise. Used by Lauren''s get_deal_url tool.';
