-- ═══ Homeowner intake submission RPC ════════════════════════════════
create or replace function public.submit_homeowner_intake(
  p_token uuid,
  p_data jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  access_row public.homeowner_intake_access%rowtype;
  current_meta jsonb;
  current_inv jsonb;
  merged_inv jsonb;
begin
  if p_token is null then raise exception 'token required'; end if;
  if p_data is null or jsonb_typeof(p_data) != 'object' then raise exception 'data must be an object'; end if;

  select * into access_row from public.homeowner_intake_access
  where token = p_token and enabled = true and revoked_at is null;
  if not found then raise exception 'access denied'; end if;

  select coalesce(meta, '{}'::jsonb) into current_meta from public.deals where id = access_row.deal_id;
  current_inv := coalesce(current_meta->'investor', '{}'::jsonb);

  merged_inv := current_inv
    || jsonb_build_object(
        'homeowner_said', p_data,
        'homeowner_submitted_at', now()::text,
        'homeowner_name', coalesce(access_row.homeowner_name, current_inv->>'homeowner_name')
      );

  -- Promote well-known fields only if not already set by Nathan
  if (p_data->>'beds') is not null and (current_inv->>'beds') is null then
    merged_inv := merged_inv || jsonb_build_object('beds', p_data->>'beds');
  end if;
  if (p_data->>'baths') is not null and (current_inv->>'baths') is null then
    merged_inv := merged_inv || jsonb_build_object('baths', p_data->>'baths');
  end if;
  if (p_data->>'sqft') is not null and (current_inv->>'sqft') is null then
    merged_inv := merged_inv || jsonb_build_object('sqft', p_data->>'sqft');
  end if;
  if (p_data->>'yearBuilt') is not null and (current_inv->>'yearBuilt') is null then
    merged_inv := merged_inv || jsonb_build_object('yearBuilt', p_data->>'yearBuilt');
  end if;
  if (p_data->>'lotSize') is not null and (current_inv->>'lotSize') is null then
    merged_inv := merged_inv || jsonb_build_object('lotSize', p_data->>'lotSize');
  end if;
  if (p_data->>'occupancy') is not null and (current_inv->>'occupancy') is null then
    merged_inv := merged_inv || jsonb_build_object('occupancy', p_data->>'occupancy');
  end if;
  if (p_data->>'accessNotes') is not null and (current_inv->>'accessNotes') is null then
    merged_inv := merged_inv || jsonb_build_object('accessNotes', p_data->>'accessNotes');
  end if;

  -- Condition groups (roof, hvac, etc.) — promote each if not already set
  for merged_inv in
    select merged_inv || coalesce(jsonb_object_agg(k, p_data->k) filter (where p_data->k is not null and current_inv->k is null), '{}'::jsonb)
    from unnest(array['roof','hvac','waterHeater','electrical','plumbing','windows','exterior','basement','foundation']) as k
  loop
    exit;
  end loop;

  if (p_data->>'knownIssues') is not null and (current_inv->>'knownIssues') is null then
    merged_inv := merged_inv || jsonb_build_object('knownIssues', p_data->>'knownIssues');
  end if;

  update public.deals
  set meta = current_meta || jsonb_build_object('investor', merged_inv)
  where id = access_row.deal_id;

  update public.homeowner_intake_access
  set completed_at = now(),
      submission_count = submission_count + 1,
      last_viewed_at = now()
  where id = access_row.id;

  insert into public.activity (deal_id, user_id, action, visibility)
  values (
    access_row.deal_id, null,
    '🏠 Homeowner completed property survey' ||
      case when access_row.homeowner_name is not null then ' (' || access_row.homeowner_name || ')' else '' end,
    array['team']
  );

  return access_row.id;
end;
$$;

grant execute on function public.submit_homeowner_intake(uuid, jsonb) to anon, authenticated;

create or replace function public.get_homeowner_intake_by_token(p_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  access_row public.homeowner_intake_access%rowtype;
  deal_row public.deals%rowtype;
begin
  if p_token is null then return null; end if;
  select * into access_row from public.homeowner_intake_access
  where token = p_token and enabled = true and revoked_at is null;
  if not found then return null; end if;

  update public.homeowner_intake_access
  set last_viewed_at = now() where id = access_row.id;

  select * into deal_row from public.deals where id = access_row.deal_id;

  return jsonb_build_object(
    'homeowner_name', access_row.homeowner_name,
    'deal_id', deal_row.id,
    'address', deal_row.address,
    'county', deal_row.meta->>'county',
    'completed_at', access_row.completed_at,
    'submission_count', access_row.submission_count,
    'prior', deal_row.meta->'investor'->'homeowner_said'
  );
end;
$$;

grant execute on function public.get_homeowner_intake_by_token(uuid) to anon, authenticated;

-- ═══ Address gating ═══════════════════════════════════════════════
alter table public.investor_deal_access
  add column if not exists address_requested_at timestamptz,
  add column if not exists address_granted_at timestamptz;

create or replace function public.request_investor_address(p_token uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  access_row public.investor_deal_access%rowtype;
begin
  if p_token is null then return false; end if;
  select * into access_row from public.investor_deal_access
  where token = p_token and enabled = true and revoked_at is null;
  if not found then return false; end if;

  update public.investor_deal_access
  set address_requested_at = coalesce(address_requested_at, now())
  where id = access_row.id;

  insert into public.activity (deal_id, user_id, action, visibility)
  values (
    access_row.deal_id, null,
    '📍 Investor requested full property address' ||
      case when access_row.investor_name is not null then ' (' || access_row.investor_name || ')' else '' end,
    array['team']
  );
  return true;
end;
$$;

grant execute on function public.request_investor_address(uuid) to anon, authenticated;

comment on function public.submit_homeowner_intake(uuid, jsonb) is
  'Token-gated homeowner survey submission. Merges wizard payload into deal.meta.investor.homeowner_said.* and promotes well-known fields (beds/baths/sqft/condition groups) to top level when not already set by Nathan.';
