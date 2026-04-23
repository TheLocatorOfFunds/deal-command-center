-- Multi-Contact Conversation View — Schema
-- Adds contact_id, thread_key, channel to messages_outbound.
-- Adds message_groups, messages_outbound_unmatched, thread_hidden tables.
-- Backfills thread_key for existing rows.

-- ── 1. message_groups ─────────────────────────────────────────────────────────
create table if not exists public.message_groups (
  id           uuid primary key default gen_random_uuid(),
  deal_id      text not null references public.deals(id) on delete cascade,
  label        text,                  -- e.g. "Casey + Maria + Nathan"
  participants jsonb not null default '[]'::jsonb,
                                      -- [{contact_id, phone, name, color}]
  channel      text not null default 'sms'
                   check (channel in ('sms', 'imessage')),
  created_at   timestamptz not null default now()
);

alter table public.message_groups enable row level security;
create policy "auth_all_message_groups" on public.message_groups
  for all to authenticated using (true) with check (true);

-- ── 2. Extend messages_outbound ───────────────────────────────────────────────
alter table public.messages_outbound
  add column if not exists contact_id  uuid references public.contacts(id) on delete set null,
  add column if not exists group_id    uuid references public.message_groups(id) on delete set null,
  add column if not exists thread_key  text,
  add column if not exists channel     text not null default 'sms'
                                           check (channel in ('sms', 'imessage'));

-- Index for fast per-deal thread listing
create index if not exists idx_messages_outbound_thread
  on public.messages_outbound (deal_id, thread_key, created_at desc)
  where thread_key is not null;

-- ── 3. messages_outbound_unmatched ────────────────────────────────────────────
-- Inbound SMS that couldn't be matched to any deal/contact lands here for triage.
create table if not exists public.messages_outbound_unmatched (
  id                  uuid primary key default gen_random_uuid(),
  from_number         text not null,
  to_number           text not null,
  body                text,
  raw_payload         jsonb,
  received_at         timestamptz not null default now(),
  -- resolution fields (filled in when Nathan tags it)
  resolved_at         timestamptz,
  resolved_contact_id uuid references public.contacts(id) on delete set null,
  resolved_deal_id    text references public.deals(id) on delete set null,
  dismissed           boolean not null default false
);

alter table public.messages_outbound_unmatched enable row level security;
create policy "auth_all_unmatched" on public.messages_outbound_unmatched
  for all to authenticated using (true) with check (true);

-- ── 4. thread_hidden — soft-archive a noisy thread ───────────────────────────
create table if not exists public.thread_hidden (
  deal_id    text not null references public.deals(id) on delete cascade,
  thread_key text not null,
  hidden_at  timestamptz not null default now(),
  primary key (deal_id, thread_key)
);

alter table public.thread_hidden enable row level security;
create policy "auth_all_thread_hidden" on public.thread_hidden
  for all to authenticated using (true) with check (true);

-- ── 5. contacts opt-out per deal ─────────────────────────────────────────────
-- Opt-out is per-deal (not global), stored on contact_deals.
alter table public.contact_deals
  add column if not exists sms_opted_out_at timestamptz;

-- ── 6. Backfill thread_key for existing messages_outbound rows ────────────────
-- Pattern: '<deal_id>:phone:<normalized_phone>'
-- We use the outbound to_number for outbound msgs, from_number for inbound.
update public.messages_outbound
set thread_key = deal_id || ':phone:' ||
  regexp_replace(
    case
      when direction = 'inbound' then coalesce(from_number, to_number)
      else coalesce(to_number, from_number)
    end,
    '[^0-9+]', '', 'g'
  )
where thread_key is null
  and deal_id is not null;
