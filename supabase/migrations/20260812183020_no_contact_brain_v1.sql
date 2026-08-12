-- ═══ THE NO-CONTACT BRAIN v1 (CEO directive invariant 1, 2026-08-12) ═══
-- ONE source of truth for "may we contact this number?" across BOTH planes.
-- may_contact(p_phone) is the gate every machine-plane send MUST call.
-- The GHL plane is enforced by keeping GHL's native DND mirrored (ghl-sync EF).
-- NOTE: this body carries a `text[] || 'literal'` append bug (Postgres parses
-- the literal as an array); superseded minutes later by
-- 20260812183105_no_contact_brain_v1_fix_append — kept verbatim for replay
-- fidelity. No call sites existed between the two.

create table if not exists public.ghl_contact_map (
  ghl_contact_id text primary key,
  dcc_contact_id uuid references public.contacts(id) on delete set null,
  phone_bare10 text,
  created_at timestamptz not null default now()
);
create index if not exists idx_ghl_map_contact on public.ghl_contact_map(dcc_contact_id);
create index if not exists idx_ghl_map_phone on public.ghl_contact_map(phone_bare10);

create table if not exists public.ghl_dnd_mirror (
  ghl_contact_id text primary key,
  phone_bare10 text,
  dnd boolean not null default false,
  ghl_updated_at timestamptz,
  synced_at timestamptz not null default now()
);
create index if not exists idx_ghl_dnd_phone on public.ghl_dnd_mirror(phone_bare10);

create table if not exists public.sync_watermarks (
  key text primary key,
  value timestamptz not null,
  detail jsonb
);

alter table public.ghl_contact_map enable row level security;
alter table public.ghl_dnd_mirror enable row level security;
alter table public.sync_watermarks enable row level security;

create or replace function public.may_contact(p_phone text)
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_catalog
as $$
declare
  v_bare text := right(regexp_replace(coalesce(p_phone,''), '\D', '', 'g'), 10);
  v_reasons text[] := '{}';
begin
  if length(v_bare) < 10 then
    return jsonb_build_object('allowed', false, 'reasons', to_jsonb(array['invalid_number']));
  end if;

  if exists (select 1 from bad_phone_numbers b
             where right(regexp_replace(b.phone,'\D','','g'),10) = v_bare) then
    v_reasons := v_reasons || 'bad_number';
  end if;

  if exists (
    select 1 from contacts c
    where (c.do_not_call or c.do_not_text)
      and exists (select 1 from unnest(string_to_array(coalesce(c.phone,''), ',')) p
                  where right(regexp_replace(p,'\D','','g'),10) = v_bare)
  ) then
    v_reasons := v_reasons || 'dcc_dnc';
  end if;

  if exists (select 1 from ghl_dnd_mirror g where g.phone_bare10 = v_bare and g.dnd) then
    v_reasons := v_reasons || 'ghl_dnd';
  end if;

  if exists (
    select 1 from contacts c
    join contact_deals cd on cd.contact_id = c.id
    join deals d on d.id = cd.deal_id
    where d.deleted_at is null
      and d.meta->'hold'->>'reason' is not null
      and (case when d.meta->'hold'->>'until' ~ '^\d{4}-\d{2}-\d{2}'
                then substring(d.meta->'hold'->>'until',1,10)::date > current_date
                else true end)
      and exists (select 1 from unnest(string_to_array(coalesce(c.phone,''), ',')) p
                  where right(regexp_replace(p,'\D','','g'),10) = v_bare)
  ) then
    v_reasons := v_reasons || 'lead_on_hold';
  end if;

  if exists (
    select 1 from contacts c
    join contact_deals cd on cd.contact_id = c.id
    join deals d on d.id = cd.deal_id
    where d.deleted_at is null
      and c.kind = 'homeowner'
      and (d.meta->>'deceased' in ('true','Y','yes') or d.meta->>'isDeceased' in ('true','Y','yes'))
      and exists (select 1 from unnest(string_to_array(coalesce(c.phone,''), ',')) p
                  where right(regexp_replace(p,'\D','','g'),10) = v_bare)
  ) then
    v_reasons := v_reasons || 'deceased_homeowner';
  end if;

  return jsonb_build_object('allowed', cardinality(v_reasons) = 0, 'reasons', to_jsonb(v_reasons));
end $$;

grant execute on function public.may_contact(text) to authenticated, service_role;
