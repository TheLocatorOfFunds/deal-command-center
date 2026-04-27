-- Add media_url column to messages_outbound for MMS / video-via-text
alter table public.messages_outbound
  add column if not exists media_url text;
