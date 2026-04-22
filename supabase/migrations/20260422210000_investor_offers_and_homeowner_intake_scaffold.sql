-- ═══ Phase 1: Investor offers ═══════════════════════════════════════
-- Captures offers investors submit via the portal. Lifecycle:
--   new -> (optional: pof-requested -> pof-confirmed) -> accepted | declined | countered | withdrawn
-- Counter-offers thread via countered_from_id so a single "negotiation"
-- can be reconstructed. Token-gated RPC writes rows from the portal;
-- admin/VA see and respond through DCC.
create table if not exists public.investor_offers (
  id uuid primary key default gen_random_uuid(),
  deal_id text not null references public.deals(id) on delete cascade,
  access_id uuid references public.investor_deal_access(id) on delete set null,

  investor_name  text,
  investor_email text,
  investor_phone text,

  offer_price numeric(12,2) not null,
  financing_type text check (financing_type in ('cash','lender','hard-money','seller','subject-to','other')),
  emd_amount numeric(12,2),
  closing_days integer,
  title_company text,
  contingencies text,
  notes text,

  pof_document_id uuid references public.documents(id) on delete set null,
  pof_status text not null default 'none' check (pof_status in ('none','requested','uploaded','verified')),

  status text not null default 'new' check (status in ('new','pof-requested','pof-confirmed','accepted','declined','countered','withdrawn','expired')),
  countered_from_id uuid references public.investor_offers(id) on delete set null,

  submitted_at timestamptz not null default now(),
  responded_at timestamptz,
  responded_by uuid references auth.users(id),
  response_note text,
  withdrawn_at timestamptz
);

create index if not exists idx_investor_offers_deal on public.investor_offers(deal_id, submitted_at desc);
create index if not exists idx_investor_offers_pending on public.investor_offers(submitted_at desc)
  where status in ('new','pof-requested','pof-confirmed');

alter table public.investor_offers enable row level security;

drop policy if exists admin_all_offers on public.investor_offers;
create policy admin_all_offers on public.investor_offers
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists va_manage_offers on public.investor_offers;
create policy va_manage_offers on public.investor_offers
  for all to authenticated using (public.is_va()) with check (public.is_va());

create or replace function public.submit_investor_offer(
  p_token uuid,
  p_offer_price numeric,
  p_financing_type text default null,
  p_emd_amount numeric default null,
  p_closing_days integer default null,
  p_title_company text default null,
  p_contingencies text default null,
  p_notes text default null,
  p_investor_phone text default null,
  p_investor_email text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  access_row public.investor_deal_access%rowtype;
  new_id uuid;
begin
  if p_token is null then raise exception 'token required'; end if;
  if p_offer_price is null or p_offer_price <= 0 then raise exception 'offer_price required'; end if;

  select * into access_row from public.investor_deal_access
  where token = p_token and enabled = true and revoked_at is null;
  if not found then raise exception 'access denied'; end if;

  insert into public.investor_offers (
    deal_id, access_id, investor_name, investor_phone, investor_email,
    offer_price, financing_type, emd_amount, closing_days,
    title_company, contingencies, notes
  ) values (
    access_row.deal_id, access_row.id,
    access_row.investor_name,
    coalesce(p_investor_phone, access_row.investor_phone),
    coalesce(p_investor_email, access_row.investor_email),
    p_offer_price, p_financing_type, p_emd_amount, p_closing_days,
    p_title_company, p_contingencies, p_notes
  ) returning id into new_id;

  insert into public.activity (deal_id, user_id, action, visibility)
  values (
    access_row.deal_id, null,
    '💰 Offer received — $' || to_char(p_offer_price, 'FM999,999,999') || ' from ' || coalesce(access_row.investor_name, 'investor') ||
      case when p_financing_type is not null then ' (' || p_financing_type || ')' else '' end,
    array['team']
  );

  return new_id;
end;
$$;

grant execute on function public.submit_investor_offer(uuid, numeric, text, numeric, integer, text, text, text, text, text) to anon, authenticated;

create or replace function public.get_investor_offer_stats(p_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  access_row public.investor_deal_access%rowtype;
  counts jsonb;
begin
  if p_token is null then return null; end if;
  select * into access_row from public.investor_deal_access
  where token = p_token and enabled = true and revoked_at is null;
  if not found then return null; end if;

  select jsonb_build_object(
    'total', count(*) filter (where status not in ('withdrawn','expired','declined')),
    'this_investor', count(*) filter (where access_id = access_row.id and status not in ('withdrawn','expired')),
    'this_investor_latest', (
      select jsonb_build_object(
        'id', id,
        'status', status,
        'submitted_at', submitted_at,
        'offer_price', offer_price
      )
      from public.investor_offers
      where access_id = access_row.id and status not in ('withdrawn')
      order by submitted_at desc limit 1
    )
  ) into counts
  from public.investor_offers where deal_id = access_row.deal_id;

  return counts;
end;
$$;

grant execute on function public.get_investor_offer_stats(uuid) to anon, authenticated;

-- ═══ Phase 2 scaffold: Homeowner self-service intake portal ══════════
create table if not exists public.homeowner_intake_access (
  id uuid primary key default gen_random_uuid(),
  deal_id text not null references public.deals(id) on delete cascade,
  token uuid not null unique default gen_random_uuid(),
  homeowner_name text,
  homeowner_email text,
  homeowner_phone text,
  invited_by uuid references auth.users(id),
  invited_at timestamptz not null default now(),
  enabled boolean not null default true,
  completed_at timestamptz,
  revoked_at timestamptz,
  last_viewed_at timestamptz,
  submission_count integer not null default 0
);

create index if not exists idx_homeowner_intake_deal on public.homeowner_intake_access(deal_id, invited_at desc);
create index if not exists idx_homeowner_intake_token on public.homeowner_intake_access(token);

alter table public.homeowner_intake_access enable row level security;

drop policy if exists admin_all_homeowner_intake on public.homeowner_intake_access;
create policy admin_all_homeowner_intake on public.homeowner_intake_access
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists va_manage_homeowner_intake on public.homeowner_intake_access;
create policy va_manage_homeowner_intake on public.homeowner_intake_access
  for all to authenticated using (public.is_va()) with check (public.is_va());

comment on table public.investor_offers is
  'Structured offers from investors via the portal. Lifecycle: new -> pof-requested -> pof-confirmed -> accepted/declined/countered. Counter-offers thread via countered_from_id.';
comment on table public.homeowner_intake_access is
  'Phase 2 scaffold: token-based portal for homeowners (preforeclosure sellers) to self-report property condition. Data feeds deal.meta.investor on submission.';
