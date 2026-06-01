-- Fix the lauren_get_deal_url admin/VA gate so the lauren-team-respond
-- EF (which calls db.rpc with service_role) actually gets data back.
--
-- Before this fix the EF was receiving NULL on every get_deal_url tool
-- call (auth.uid() is NULL under service_role, so is_admin() / is_va()
-- both returned false, so the function short-circuited). Lauren saw
-- NULL come back from the tool and hallucinated URLs like
-- https://app.castleai.com/deals/<deal_id> in chat replies.
--
-- The EF already authorizes its callers upstream in authorize() (shared
-- secret for the pg trigger path OR admin/VA JWT for the frontend path),
-- so letting service_role through here is safe.

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
  if auth.role() is distinct from 'service_role'
     and not (public.is_admin() or public.is_va()) then
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
