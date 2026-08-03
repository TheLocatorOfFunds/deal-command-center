-- Docket Center flood guard (2026-08-03) — third flood: 401 → 3,267 → 5,433
-- unacked, ~90% historical docket-history dumps arriving unflagged from
-- upstream despite the 2026-07-06 is_backfill ferry. The DCC now defends
-- itself: any docket event that is flagged backfill OR happened >30 days ago
-- self-acknowledges at INSERT. It stays on the deal's timeline as research
-- context; it just never lands in the cross-deal needs-attention queue.
-- Genuinely new events (fresh docket movement) are untouched.
create or replace function public.tg_autoack_docket_history()
returns trigger language plpgsql security definer set search_path to 'public' as $fn$
begin
  if NEW.acknowledged_at is null and (
       coalesce(NEW.is_backfill, false)
       or (NEW.event_date is not null and NEW.event_date < (current_date - 30))
     ) then
    NEW.acknowledged_at := now();
  end if;
  return NEW;
end $fn$;
drop trigger if exists autoack_docket_history on public.docket_events;
create trigger autoack_docket_history
  before insert on public.docket_events
  for each row execute function public.tg_autoack_docket_history();
