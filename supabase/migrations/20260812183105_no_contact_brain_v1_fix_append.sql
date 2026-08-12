-- Fix: text[] || 'literal' parses the literal as an array in plpgsql
-- assignment context ("malformed array literal") — replace every append
-- with explicit array_append(). This is the LIVE may_contact body.

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
    v_reasons := array_append(v_reasons, 'bad_number');
  end if;

  if exists (
    select 1 from contacts c
    where (c.do_not_call or c.do_not_text)
      and exists (select 1 from unnest(string_to_array(coalesce(c.phone,''), ',')) p
                  where right(regexp_replace(p,'\D','','g'),10) = v_bare)
  ) then
    v_reasons := array_append(v_reasons, 'dcc_dnc');
  end if;

  if exists (select 1 from ghl_dnd_mirror g where g.phone_bare10 = v_bare and g.dnd) then
    v_reasons := array_append(v_reasons, 'ghl_dnd');
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
    v_reasons := array_append(v_reasons, 'lead_on_hold');
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
    v_reasons := array_append(v_reasons, 'deceased_homeowner');
  end if;

  return jsonb_build_object('allowed', cardinality(v_reasons) = 0, 'reasons', to_jsonb(v_reasons));
end $$;
