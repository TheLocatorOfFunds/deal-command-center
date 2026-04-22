-- Token-based investor portal access. No auth.users row required; each row
-- has an opaque uuid token that Nathan texts or emails to a buyer. Investor
-- hits investor-portal.html?t={token} and an RPC resolves the token to deal
-- data. Revocation = set revoked_at / enabled=false.
create table if not exists public.investor_deal_access (
  id uuid primary key default gen_random_uuid(),
  deal_id text not null references public.deals(id) on delete cascade,
  token uuid not null unique default gen_random_uuid(),
  investor_name text,
  investor_email text,
  investor_phone text,
  notes text,
  invited_by uuid references auth.users(id),
  invited_at timestamptz not null default now(),
  enabled boolean not null default true,
  revoked_at timestamptz,
  last_viewed_at timestamptz,
  view_count integer not null default 0
);

create index if not exists idx_investor_deal_access_deal on public.investor_deal_access(deal_id, invited_at desc);
create index if not exists idx_investor_deal_access_token on public.investor_deal_access(token);

alter table public.investor_deal_access enable row level security;

drop policy if exists admin_all_investor_access on public.investor_deal_access;
create policy admin_all_investor_access on public.investor_deal_access
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists va_manage_investor_access on public.investor_deal_access;
create policy va_manage_investor_access on public.investor_deal_access
  for all to authenticated using (public.is_va()) with check (public.is_va());

-- Investor-visible flag on documents so Nathan can mark which docs + photos
-- are shared with the buyer (vs internal-only like the engagement letter).
alter table public.documents
  add column if not exists investor_visible boolean not null default false;

create index if not exists idx_documents_investor_visible
  on public.documents(deal_id) where investor_visible = true;

-- The token resolver RPC. Returns a jsonb blob containing only
-- investor-safe fields from the deal (strips internal financial data), a
-- list of investor-flagged documents, and access-row tracking. Runs as
-- SECURITY DEFINER so anonymous callers (grant below) can reach it without
-- exposing the underlying tables.
create or replace function public.get_investor_deal_by_token(p_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  access_row public.investor_deal_access%rowtype;
  deal_row   public.deals%rowtype;
  inv_meta   jsonb;
  docs       jsonb;
  result     jsonb;
begin
  if p_token is null then return null; end if;

  select * into access_row
  from public.investor_deal_access
  where token = p_token and enabled = true and revoked_at is null;
  if not found then return null; end if;

  select * into deal_row from public.deals where id = access_row.deal_id;
  if not found then return null; end if;

  update public.investor_deal_access
  set last_viewed_at = now(), view_count = view_count + 1
  where id = access_row.id;

  inv_meta := coalesce(deal_row.meta->'investor', '{}'::jsonb);

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', d.id,
    'name', d.name,
    'path', d.path,
    'size', d.size,
    'created_at', d.created_at,
    'document_type', d.extracted->>'document_type',
    'is_cover', (d.path = (inv_meta->>'coverPhotoPath'))
  ) order by d.created_at asc), '[]'::jsonb)
  into docs
  from public.documents d
  where d.deal_id = deal_row.id and d.investor_visible = true;

  result := jsonb_build_object(
    'access_id', access_row.id,
    'investor_name', access_row.investor_name,
    'invited_at', access_row.invited_at,
    'deal', jsonb_build_object(
      'id', deal_row.id,
      'headline_address', deal_row.address,
      'county', deal_row.meta->>'county',
      'type', deal_row.type,
      'investor', inv_meta
    ),
    'documents', docs,
    'cover_photo_path', inv_meta->>'coverPhotoPath'
  );

  return result;
end;
$$;

grant execute on function public.get_investor_deal_by_token(uuid) to anon, authenticated;

create or replace function public.get_investor_document_url(p_token uuid, p_document_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  valid_deal text;
begin
  if p_token is null or p_document_id is null then return null; end if;

  select d.deal_id into valid_deal
  from public.documents d
  join public.investor_deal_access a on a.deal_id = d.deal_id
  where d.id = p_document_id
    and d.investor_visible = true
    and a.token = p_token
    and a.enabled = true
    and a.revoked_at is null;
  if not found then return null; end if;

  return (select path from public.documents where id = p_document_id);
end;
$$;

grant execute on function public.get_investor_document_url(uuid, uuid) to anon, authenticated;

comment on table public.investor_deal_access is
  'Token-based buyer/investor access to deals. Nathan generates a token, texts it to a buyer, buyer opens investor-portal.html?t={token} — no signup. All access gated via get_investor_deal_by_token RPC.';
