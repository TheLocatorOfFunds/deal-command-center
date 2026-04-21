-- Add direction column to messages_outbound for inbound SMS support
alter table public.messages_outbound
  add column if not exists direction text not null default 'outbound';

create index if not exists messages_outbound_direction_idx
  on public.messages_outbound (direction);
