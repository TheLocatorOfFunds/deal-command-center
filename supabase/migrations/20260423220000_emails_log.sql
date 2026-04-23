-- Outbound email log for the Comms thread. Each row represents an email
-- sent FROM Nathan TO an attorney/client/partner via Resend. Renders as a
-- 📧 email bubble in the Comms timeline alongside SMS and calls.
create table if not exists public.emails (
  id uuid primary key default gen_random_uuid(),
  deal_id text references public.deals(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  thread_key text,
  direction text not null default 'outbound' check (direction in ('outbound','inbound')),
  from_email text not null,
  to_emails text[] not null,
  cc_emails text[],
  bcc_emails text[],
  reply_to text,
  subject text not null,
  body_text text,
  body_html text,
  resend_id text,
  status text not null default 'sent' check (status in ('queued','sent','failed','delivered','bounced')),
  error_message text,
  sent_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_emails_deal_created on public.emails(deal_id, created_at desc);
create index if not exists idx_emails_thread on public.emails(thread_key, created_at desc) where thread_key is not null;

alter table public.emails enable row level security;

drop policy if exists emails_admin_all on public.emails;
create policy emails_admin_all on public.emails
  for all to authenticated
  using (public.is_admin() or public.is_va())
  with check (public.is_admin() or public.is_va());

drop policy if exists emails_attorney_read on public.emails;
create policy emails_attorney_read on public.emails
  for select to authenticated
  using (
    public.is_attorney()
    and deal_id in (
      select deal_id from public.attorney_assignments
      where user_id = auth.uid() and enabled = true
    )
  );

comment on table public.emails is
  'Outbound + inbound email log per deal. Sent via Resend (from=nathan@refundlocators.com, reply-to=nathan@fundlocators.com, bcc=nathan@fundlocators.com so every outbound also lands in the shared Gmail). Renders inline in the Comms thread.';
