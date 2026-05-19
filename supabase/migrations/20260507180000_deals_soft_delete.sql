-- Soft-delete on deals.
-- Per Nathan 2026-05-07: needs a way to remove leads that turn out
-- not-real (sale unwound / data error / judgment paid pre-sale / etc.)
-- without losing the artifacts attached to them — sent SMS history,
-- court PDFs, AI case summaries, personalized URLs, and the activity
-- audit trail. Hard delete would cascade-destroy all of that.
--
-- Pattern: tombstone columns on the deals row itself. Active queries
-- filter `deleted_at IS NULL`; the admin "Deleted Leads" view filters
-- the inverse. Restore is a single UPDATE setting all three back to
-- NULL — way simpler than rehydrating from an archive table.
--
-- Status `dead` stays distinct: that's "we worked it, didn't pan out."
-- Soft-delete is "this lead shouldn't have entered the system at all."
-- Different semantics → different mechanics.

alter table public.deals
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_reason text,
  add column if not exists deleted_by uuid references auth.users(id) on delete set null;

-- Reason allowlist enforced at the DB layer so a typo can't slip in
-- and break the analytics query (`select deleted_reason, count(*) ...`).
alter table public.deals
  drop constraint if exists deals_deleted_reason_check;

alter table public.deals
  add constraint deals_deleted_reason_check
  check (
    deleted_reason is null
    or deleted_reason in (
      'sale_unwound',
      'judgment_paid_pre_sale',
      'owner_reinstated',
      'duplicate',
      'data_error',
      'bankruptcy_filed',
      'no_surplus',
      'other'
    )
  );

-- Partial index — covers the common case (active deals) without
-- bloating the index with tombstones we rarely query.
create index if not exists idx_deals_active
  on public.deals (created_at desc)
  where deleted_at is null;

-- Index for the Deleted Leads view — admin sees them sorted by
-- delete time desc.
create index if not exists idx_deals_deleted
  on public.deals (deleted_at desc)
  where deleted_at is not null;

comment on column public.deals.deleted_at is
  'Soft-delete timestamp. NULL = active. Set by admin via the "Delete deal" UI. Excluded from kanban / funnel / auto-queue / dashboards but kept in DB so we never lose sent SMS history, court PDFs, AI summaries, personalized URLs, or activity logs. Restore by setting back to NULL.';

comment on column public.deals.deleted_reason is
  'Why the deal was soft-deleted. Allowlisted: sale_unwound | judgment_paid_pre_sale | owner_reinstated | duplicate | data_error | bankruptcy_filed | no_surplus | other.';

comment on column public.deals.deleted_by is
  'auth.users.id of the admin who soft-deleted. Audit trail. Set null on user delete cascade so we keep the timestamp + reason even if the deleting user account is removed.';
