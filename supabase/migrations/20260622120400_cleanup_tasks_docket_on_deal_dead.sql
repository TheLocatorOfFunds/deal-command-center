-- When a deal goes dead or is soft-deleted, stop it generating orphan work
-- (Nathan 2026-06-22). Closes its open tasks + acknowledges its unacked docket
-- events, so dead deals don't inflate the Follow-ups / Docket badges or clutter
-- the queues. Fires only on the transition INTO dead/deleted (not every update).
-- Scoped to dead + deleted only — closed/recovered (successful) deals keep their
-- tasks/docket since post-recovery follow-up is legitimate. SECURITY DEFINER so
-- a VA's delete still triggers the cleanup. Applied to prod via MCP apply_migration.
-- One-time backfill (run alongside): closed 120 stale tasks, acked 436 dead-deal
-- docket events.
create or replace function public.tg_cleanup_on_deal_dead()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.tasks
     set done = true
   where deal_id = NEW.id and done = false;
  update public.docket_events
     set acknowledged_at = now()
   where deal_id = NEW.id and acknowledged_at is null;
  return NEW;
end;
$$;

drop trigger if exists tg_cleanup_on_deal_dead on public.deals;
create trigger tg_cleanup_on_deal_dead
  after update on public.deals
  for each row
  when (
    (NEW.deleted_at is not null and OLD.deleted_at is null)
    or (NEW.status = 'dead' and OLD.status is distinct from 'dead')
  )
  execute function public.tg_cleanup_on_deal_dead();

-- one-time backfill for the existing backlog
update public.tasks t set done = true
  from public.deals d
 where t.deal_id = d.id and t.done = false
   and (d.deleted_at is not null or d.status = 'dead');
update public.docket_events k set acknowledged_at = now()
  from public.deals d
 where k.deal_id = d.id and k.acknowledged_at is null
   and (d.deleted_at is not null or d.status = 'dead');
