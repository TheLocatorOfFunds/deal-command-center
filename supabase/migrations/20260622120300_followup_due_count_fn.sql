-- Follow-ups badge count, matching FollowupsView's body filter (Nathan 2026-06-22).
-- The badge used to count raw tasks, so a follow-up left on a soft-deleted /
-- dead / closed / recovered deal inflated it (badge said 1 while the body showed
-- 0 — orphan follow-up on deleted deal sf-daggs). This counts only "due now"
-- follow-ups whose deal is live, exactly like the view body. SECURITY INVOKER so
-- tasks/deals RLS still applies. Applied to prod via MCP apply_migration.
create or replace function public.get_followup_due_count()
returns int
language sql
stable
security invoker
set search_path = public
as $$
  select count(*)::int
  from tasks t
  join deals d on d.id = t.deal_id
  where t.title ilike 'follow up%'
    and t.done = false
    and t.due_date <= current_date
    and d.deleted_at is null
    and d.status not in ('dead','closed','recovered');
$$;
grant execute on function public.get_followup_due_count() to authenticated;
