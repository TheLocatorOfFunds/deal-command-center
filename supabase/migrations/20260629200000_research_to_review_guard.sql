-- Guard: surplus leads pushed with status='research' must not land in the active
-- Deals tab (Nathan 2026-06-29). The DCC has no 'research' status, so 10 Ohio
-- "June surplus" review candidates leaked into Deals instead of the Review flow.
-- This trigger reroutes any incoming 'research' surplus lead to a lead +
-- manual_review flag, so it shows in the 🔎 Review queue for cleaning — durable
-- regardless of what the upstream push sends.
create or replace function public.tg_route_research_to_review()
returns trigger language plpgsql security definer set search_path to 'public' as $fn$
begin
  if NEW.type = 'surplus' and NEW.status = 'research' then
    NEW.status := 'new-lead';
    if not (coalesce(NEW.meta,'{}'::jsonb) ? 'manual_review') then
      NEW.meta := coalesce(NEW.meta,'{}'::jsonb) || jsonb_build_object('manual_review', jsonb_build_object(
        'reason', 'Came in as a research candidate (status=research) — verify it is a real homeowner surplus (not an investor/LLC), confirm the amount, and find the homeowner before working.',
        'flagged_by', 'auto (research → review guard)',
        'flagged_at', now()::text
      ));
    end if;
  end if;
  return NEW;
end $fn$;

drop trigger if exists route_research_to_review on public.deals;
create trigger route_research_to_review
  before insert or update on public.deals
  for each row execute function public.tg_route_research_to_review();
