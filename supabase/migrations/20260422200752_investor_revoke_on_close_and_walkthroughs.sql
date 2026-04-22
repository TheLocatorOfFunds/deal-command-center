-- 1. Auto-revoke investor access when a deal closes or dies.
-- Trigger fires on UPDATE of deals.status. If new status is closed/dead/recovered,
-- flip all enabled investor_deal_access rows to revoked.
create or replace function public.auto_revoke_investor_access_on_close()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.status in ('closed', 'dead', 'recovered') and
     (OLD.status is distinct from NEW.status) then
    update public.investor_deal_access
    set enabled = false,
        revoked_at = coalesce(revoked_at, now()),
        notes = coalesce(notes, '') || ' [auto-revoked: deal marked ' || NEW.status || ']'
    where deal_id = NEW.id
      and enabled = true
      and revoked_at is null;
  end if;
  return NEW;
end;
$$;

drop trigger if exists tg_auto_revoke_investor_on_close on public.deals;
create trigger tg_auto_revoke_investor_on_close
  after update of status on public.deals
  for each row
  execute function public.auto_revoke_investor_access_on_close();

-- 2. Walkthrough request queue. Investor hits "Request walkthrough" in the
-- portal; a row lands here; DCC subscribes via realtime; Nathan's phone
-- gets a Twilio text via the notify-walkthrough-request Edge Function.
create table if not exists public.walkthrough_requests (
  id uuid primary key default gen_random_uuid(),
  deal_id text not null references public.deals(id) on delete cascade,
  access_id uuid references public.investor_deal_access(id) on delete set null,
  investor_name text,
  investor_phone text,
  investor_email text,
  preferred_time text,
  investor_note text,
  status text not null default 'pending'
    check (status in ('pending', 'contacted', 'scheduled', 'completed', 'dismissed')),
  created_at timestamptz not null default now(),
  handled_at timestamptz,
  handled_by uuid references auth.users(id)
);

create index if not exists idx_walkthrough_requests_deal on public.walkthrough_requests(deal_id, created_at desc);
create index if not exists idx_walkthrough_requests_pending on public.walkthrough_requests(created_at desc) where status = 'pending';

alter table public.walkthrough_requests enable row level security;

drop policy if exists admin_all_walkthrough on public.walkthrough_requests;
create policy admin_all_walkthrough on public.walkthrough_requests
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists va_manage_walkthrough on public.walkthrough_requests;
create policy va_manage_walkthrough on public.walkthrough_requests
  for all to authenticated using (public.is_va()) with check (public.is_va());

-- Token-gated RPC for the portal to submit a request. Anon callable.
create or replace function public.submit_walkthrough_request(
  p_token uuid,
  p_preferred_time text default null,
  p_note text default null,
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

  select * into access_row from public.investor_deal_access
  where token = p_token and enabled = true and revoked_at is null;
  if not found then raise exception 'access denied'; end if;

  insert into public.walkthrough_requests (
    deal_id, access_id, investor_name, investor_phone, investor_email,
    preferred_time, investor_note
  ) values (
    access_row.deal_id,
    access_row.id,
    access_row.investor_name,
    coalesce(p_investor_phone, access_row.investor_phone),
    coalesce(p_investor_email, access_row.investor_email),
    p_preferred_time,
    p_note
  ) returning id into new_id;

  insert into public.activity (deal_id, user_id, action, visibility)
  values (
    access_row.deal_id,
    null,
    '🏠 Walkthrough requested by ' || coalesce(access_row.investor_name, 'an investor') ||
      case when p_preferred_time is not null then ' — prefers ' || p_preferred_time else '' end,
    array['team']
  );

  return new_id;
end;
$$;

grant execute on function public.submit_walkthrough_request(uuid, text, text, text, text) to anon, authenticated;

comment on table public.walkthrough_requests is
  'Investor-portal-submitted requests to walk the property. Inserted via submit_walkthrough_request RPC (token-gated). DCC subscribes via realtime; notify-walkthrough Edge Function texts Nathan.';
