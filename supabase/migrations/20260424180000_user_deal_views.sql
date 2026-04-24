-- user_deal_views — per-user read receipts for the deal-detail tabs.
-- Lets DCC show "N unread since you last looked" badges on Docket +
-- Comms tabs for each user independently.
--
-- Pattern:
--   - Upsert last_seen_at = now() when the user opens a tab
--   - Query: "count of <thing> where created_at > my last_seen_at for this tab"
--   - Scoped per user so Nathan's reads don't mark things seen for Justin

create table if not exists public.user_deal_views (
  user_id      uuid        not null references auth.users(id) on delete cascade,
  deal_id      text        not null references public.deals(id) on delete cascade,
  tab          text        not null check (tab in ('overview','comms','docket','contacts','investor','expenses','tasks','files')),
  last_seen_at timestamptz not null default now(),
  primary key (user_id, deal_id, tab)
);

create index if not exists idx_user_deal_views_user_deal
  on public.user_deal_views(user_id, deal_id);

alter table public.user_deal_views enable row level security;

drop policy if exists user_deal_views_self on public.user_deal_views;
create policy user_deal_views_self on public.user_deal_views
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

comment on table public.user_deal_views is
  'Per-user last-seen timestamp per deal per tab. Drives the unread-count badges on deal-detail tabs so Nathan and Justin each see their own unread state without stepping on each other.';
