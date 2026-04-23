-- Twilio Voice integration (Stage 3 of the Comms unification).
-- Captures every inbound call on Twilio-hosted numbers: records the call,
-- forwards to Nathan's iPhone, then logs it against the matched deal so it
-- appears in the same unified thread as SMS/iMessage for that contact.
--
-- Outbound call origination is NOT part of v1 — Nathan still dials from his
-- iPhone directly (tel: links everywhere). A later migration can add
-- twilio-call Edge Function + log an outbound row when he clicks a button.

create table if not exists public.call_logs (
  id uuid primary key default gen_random_uuid(),
  deal_id text references public.deals(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  thread_key text,
  direction text not null check (direction in ('inbound','outbound')),
  from_number text not null,
  to_number text not null,
  duration_seconds int,
  status text not null default 'initiated'
    check (status in ('initiated','ringing','in-progress','completed','missed','no-answer','busy','failed','canceled')),
  recording_url text,
  recording_duration int,
  recording_sid text,
  twilio_call_sid text unique,
  started_at timestamptz,
  ended_at timestamptz,
  auto_sms_sent boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_call_logs_deal_created
  on public.call_logs(deal_id, created_at desc);
create index if not exists idx_call_logs_thread
  on public.call_logs(thread_key, created_at desc)
  where thread_key is not null;

alter table public.call_logs enable row level security;

drop policy if exists call_logs_admin_all on public.call_logs;
create policy call_logs_admin_all on public.call_logs
  for all to authenticated
  using (public.is_admin() or public.is_va())
  with check (public.is_admin() or public.is_va());

-- Attorneys see calls only on deals they're assigned to
drop policy if exists call_logs_attorney_read on public.call_logs;
create policy call_logs_attorney_read on public.call_logs
  for select to authenticated
  using (
    public.is_attorney()
    and deal_id in (
      select deal_id from public.attorney_assignments
      where user_id = auth.uid() and enabled = true
    )
  );

-- Clients DO NOT see call logs — these are internal-only team records.
-- (If you want specific calls visible to clients later, add a visibility
-- array similar to activity.visibility and gate on it.)

comment on table public.call_logs is
  'Voice-call audit log. One row per inbound or outbound call routed through Twilio. Links to a deal + contact + thread_key so calls render inline with SMS in the Comms thread. Recordings stored at recording_url (Twilio CDN).';
