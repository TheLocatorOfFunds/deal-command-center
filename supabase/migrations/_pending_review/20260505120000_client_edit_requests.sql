-- Client edit requests
--
-- Clients can submit changes to their email or phone number from the portal.
-- The request lands here as 'pending'. Nathan reviews in the DCC ClientPortalCard
-- and either approves (applies the change) or rejects it.
--
-- RLS:
--   Clients: INSERT their own (client_access_id must match their session) + SELECT their own
--   Admins:  full access
--   VAs:     read only

create table public.client_edit_requests (
  id              uuid primary key default gen_random_uuid(),
  client_access_id uuid not null references public.client_access(id) on delete cascade,
  deal_id         text not null references public.deals(id) on delete cascade,
  field           text not null check (field in ('email', 'phone')),
  new_value       text not null,
  old_value       text,
  status          text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  requested_at    timestamptz not null default now(),
  reviewed_at     timestamptz,
  reviewed_by     uuid references auth.users(id)
);

create index idx_client_edit_requests_deal_id  on public.client_edit_requests(deal_id);
create index idx_client_edit_requests_ca_id    on public.client_edit_requests(client_access_id);
create index idx_client_edit_requests_status   on public.client_edit_requests(status) where status = 'pending';

-- ── RLS ────────────────────────────────────────────────────────────────────

alter table public.client_edit_requests enable row level security;

-- Admins: unrestricted
create policy "admin_all_client_edit_requests"
  on public.client_edit_requests
  for all
  using (public.is_admin())
  with check (public.is_admin());

-- VAs: read only
create policy "va_read_client_edit_requests"
  on public.client_edit_requests
  for select
  using (public.is_va());

-- Clients: insert their own requests (must own the client_access row)
create policy "client_insert_edit_requests"
  on public.client_edit_requests
  for insert
  with check (
    public.is_client()
    and client_access_id in (
      select id from public.client_access
      where user_id = auth.uid() and enabled = true
    )
  );

-- Clients: read their own requests
create policy "client_read_own_edit_requests"
  on public.client_edit_requests
  for select
  using (
    public.is_client()
    and client_access_id in (
      select id from public.client_access
      where user_id = auth.uid()
    )
  );

comment on table public.client_edit_requests is
  'Pending contact-info change requests from clients (email / phone).
   Nathan approves or rejects each one from the ClientPortalCard in DCC.
   Approval writes the new value back to client_access.email or client_access.prefs.
   Created 2026-05-05.';
