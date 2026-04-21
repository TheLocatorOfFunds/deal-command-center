-- Add direction column to messages_outbound for inbound SMS support
alter table public.messages_outbound
  add column if not exists direction text not null default 'outbound';

create index if not exists messages_outbound_direction_idx
  on public.messages_outbound (direction);

-- Allow all authenticated users to read inbound messages
-- (sent_by is null for inbound so the select_own policy won't match)
create policy "sms_inbound_select" on public.messages_outbound
  for select to authenticated
  using (direction = 'inbound');

-- DB function for flexible phone number lookup (handles +1 prefix variants)
create or replace function find_deal_by_phone(phone_e164 text, phone_bare text)
returns table(id text) language sql security definer as $$
  select id from deals
  where meta->>'homeownerPhone' = phone_e164
     or meta->>'homeownerPhone' = phone_bare
  limit 1;
$$;
