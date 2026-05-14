-- esignatures_contracts — parallel signing pipeline alongside docusign_envelopes
--
-- Per Justin 2026-05-14 (post-DocuSign-Enterprise-quote): we are keeping the
-- DocuSign integration intact and adding eSignatures.com as a SEPARATE
-- pipeline. They share nothing — different tables, different EFs, different
-- UI modals. Justin can choose per-envelope which provider to use.
--
-- Schema deliberately mirrors docusign_envelopes column-for-column where
-- possible so the realtime + activity-feed wiring already in the UI works
-- with minimal new code. eSignatures.com-specific things:
--   - contract_id text (not UUID — they return their own ID format)
--   - signer_url  text (the sign_page_url returned by their API; this is
--                       the URL we drop into the Twilio SMS for delivery)
--   - status enum extended to include their event names
--
-- Recipients: eSignatures.com supports multiple signers per contract; for
-- Phase 1 we mirror the docusign 1-recipient model. Multi-signer (e.g.
-- joint claimants) gets added later via a child table.

create table if not exists public.esignatures_contracts (
  id                    uuid primary key default gen_random_uuid(),
  deal_id               text not null references public.deals(id) on delete cascade,
  library_document_id   uuid references public.library_documents(id) on delete set null,
  contract_id           text,                          -- eSignatures.com contract id
  status                text not null default 'draft' check (status in (
                          'draft', 'sent', 'viewed', 'signed', 'completed',
                          'declined', 'withdrawn', 'error'
                        )),
  recipient_email       text,
  recipient_name        text,
  recipient_phone       text,
  send_sms              boolean not null default true,
  signer_url            text,                          -- sign_page_url from API; what we SMS to homeowner
  merge_values          jsonb,
  sent_at               timestamptz,
  viewed_at             timestamptz,
  signed_at             timestamptz,
  completed_at          timestamptz,
  withdrawn_at          timestamptz,
  withdrawn_reason      text,
  signed_document_id    uuid references public.documents(id) on delete set null,
  signed_document_path  text,
  esig_api_error        text,
  sent_by               uuid references auth.users(id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists esignatures_contracts_deal_id_idx
  on public.esignatures_contracts (deal_id, created_at desc);
create index if not exists esignatures_contracts_contract_id_idx
  on public.esignatures_contracts (contract_id)
  where contract_id is not null;
create index if not exists esignatures_contracts_status_idx
  on public.esignatures_contracts (status);

-- Auto-bump updated_at on writes.
create or replace function public.tg_esignatures_contracts_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end$$;

drop trigger if exists esignatures_contracts_set_updated_at on public.esignatures_contracts;
create trigger esignatures_contracts_set_updated_at
  before update on public.esignatures_contracts
  for each row execute function public.tg_esignatures_contracts_set_updated_at();

-- RLS: admin + va read/write. Mirrors docusign_envelopes' admin_va pattern.
alter table public.esignatures_contracts enable row level security;

create policy esig_admin_va_select on public.esignatures_contracts
  for select using (public.is_admin() or public.is_va());

create policy esig_admin_va_insert on public.esignatures_contracts
  for insert with check (public.is_admin() or public.is_va());

create policy esig_admin_va_update on public.esignatures_contracts
  for update using (public.is_admin() or public.is_va());

create policy esig_admin_delete on public.esignatures_contracts
  for delete using (public.is_admin());

-- Service-role policy so the EF webhook can write status updates without
-- needing a user JWT (signed-by-vendor-webhook flow).
create policy esig_service_role_all on public.esignatures_contracts
  for all using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

grant select, insert, update on public.esignatures_contracts to authenticated;

-- library_documents — add esignatures_template_id column so the modal can
-- filter library docs to only those with an eSignatures.com template wired.
-- Mirrors the existing docusign_template_id pattern.
alter table public.library_documents
  add column if not exists esignatures_template_id text;

comment on column public.library_documents.esignatures_template_id is
  'eSignatures.com template id. When set, the document is selectable in the eSignatures send modal. Independent of docusign_template_id — a template can be wired to one or both providers.';

-- Realtime publication so the UI can react to webhook-driven status updates
-- without polling. Idempotent guard so re-running is safe.
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'esignatures_contracts'
  ) then
    alter publication supabase_realtime add table public.esignatures_contracts;
  end if;
end $$;
