-- Call Queue "never called" tag never cleared (Eric 2026-06-29). The queue reads
-- deals.last_contacted_at, but NOTHING ever wrote it — not the client, not the
-- disposition modal, no trigger. So every lead showed "never called" no matter
-- how many times it was called (Eric called 4 leads with 1-12 calls each; all
-- still showed null).
--
-- Fix: stamp deals.last_contacted_at whenever a call is logged (insert or
-- outcome update on call_logs), + backfill from existing call history.
create or replace function public.tg_stamp_deal_last_contacted()
returns trigger language plpgsql security definer set search_path to 'public' as $fn$
begin
  if NEW.deal_id is not null and NEW.started_at is not null then
    update public.deals
       set last_contacted_at = NEW.started_at
     where id = NEW.deal_id
       and (last_contacted_at is null or last_contacted_at < NEW.started_at);
  end if;
  return NEW;
end $fn$;

drop trigger if exists stamp_deal_last_contacted on public.call_logs;
create trigger stamp_deal_last_contacted
  after insert or update on public.call_logs
  for each row execute function public.tg_stamp_deal_last_contacted();

-- Backfill historical calls.
update public.deals d
   set last_contacted_at = sub.mx
  from (select deal_id, max(started_at) mx from public.call_logs
        where deal_id is not null and started_at is not null group by deal_id) sub
 where d.id = sub.deal_id
   and (d.last_contacted_at is null or d.last_contacted_at < sub.mx);
