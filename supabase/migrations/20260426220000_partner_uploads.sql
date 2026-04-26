-- Track which documents a JV partner uploaded via partner-portal. Useful so
-- the activity log can show "Kevin uploaded: front.jpg" with attribution,
-- and so the partner portal can highlight "your uploads" if we ever want to.
alter table public.documents
  add column if not exists uploaded_by_partner_access_id uuid
    references public.partner_deal_access(id) on delete set null;

alter table public.documents
  add column if not exists uploaded_by_partner_at timestamptz;

create index if not exists idx_documents_partner_uploads
  on public.documents(uploaded_by_partner_access_id, uploaded_by_partner_at desc)
  where uploaded_by_partner_access_id is not null;
