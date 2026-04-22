-- On-demand "pull this case from the court" queue. When a VA or admin clicks
-- "Pull from court" on a deal, a row is inserted here. Castle's Mac Mini
-- polls this table, picks up queued rows, runs the matching county scraper
-- for the case_number, fetches all PDFs, uploads them to deal-docs bucket,
-- inserts documents rows (which auto-triggers extract-document OCR), and
-- inserts docket_events rows. On completion Castle updates this row's
-- status='done' with counts.
--
-- See also: docs/CASTLE_COURT_PULL_HANDOFF.md (written separately).

create table if not exists public.court_pull_requests (
  id uuid primary key default gen_random_uuid(),
  deal_id text not null references public.deals(id) on delete cascade,
  case_number text not null,
  county text not null,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'done', 'failed', 'cancelled')),
  requested_by uuid references auth.users(id),
  requested_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  error text,
  documents_added integer default 0,
  events_added integer default 0,
  notes text
);

create index if not exists idx_court_pull_requests_queued
  on public.court_pull_requests(requested_at asc)
  where status = 'queued';

create index if not exists idx_court_pull_requests_deal
  on public.court_pull_requests(deal_id, requested_at desc);

alter table public.court_pull_requests enable row level security;

drop policy if exists admin_all_court_pulls on public.court_pull_requests;
create policy admin_all_court_pulls on public.court_pull_requests
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists va_insert_court_pulls on public.court_pull_requests;
create policy va_insert_court_pulls on public.court_pull_requests
  for insert to authenticated
  with check (public.is_va());

drop policy if exists va_select_court_pulls on public.court_pull_requests;
create policy va_select_court_pulls on public.court_pull_requests
  for select to authenticated
  using (public.is_va());

comment on table public.court_pull_requests is
  'On-demand queue of court-docket fetch requests. DCC writes. Castle (Mac Mini daemon) polls + processes + updates status.';
