-- Call recordings from Quo (formerly OpenPhone)
-- Stores metadata, recording URL, and transcript for every call
-- linked to a deal via phone number matching.

create table if not exists public.call_recordings (
  id               uuid primary key default gen_random_uuid(),
  deal_id          text references public.deals(id) on delete set null,
  contact_id       uuid references public.contacts(id) on delete set null,

  -- Quo call metadata
  quo_call_id      text unique not null,      -- Quo's internal call ID (for dedup)
  direction        text not null              -- 'inbound' | 'outbound'
                     check (direction in ('inbound', 'outbound')),
  from_number      text not null,
  to_number        text not null,
  duration_seconds int,                       -- call duration in seconds
  status           text,                      -- 'completed' | 'missed' | 'voicemail'
  called_at        timestamptz not null,      -- when the call started

  -- Recording
  recording_url    text,                      -- Quo-hosted audio URL
  recording_stored_url text,                  -- if we copy to Supabase Storage

  -- Transcript + AI summary
  transcript       text,                      -- raw transcript from Quo
  ai_summary       text,                      -- Claude-generated summary
  ai_action_items  text,                      -- extracted action items
  ai_processed_at  timestamptz,

  -- Raw payload for debugging
  raw_payload      jsonb,

  created_at       timestamptz not null default now()
);

alter table public.call_recordings enable row level security;
create policy "auth_all_call_recordings" on public.call_recordings
  for all to authenticated using (true) with check (true);

-- Index for fast per-deal listing
create index if not exists idx_call_recordings_deal
  on public.call_recordings (deal_id, called_at desc)
  where deal_id is not null;

-- Index for dedup on Quo call ID
create unique index if not exists idx_call_recordings_quo_id
  on public.call_recordings (quo_call_id);
