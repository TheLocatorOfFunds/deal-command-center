-- Require a reason to kill a lead — DB backstop (OH-Intel ferry 2026-07-24).
-- 81 kills had no substantive reason (~$7.3M unauditable); 4 confirmed-surplus
-- leads were revived after being wrongly killed. The web UI gates kills through
-- the disposition/delete modals, but mobile + SQL paths bypassed it — this
-- trigger closes every path:
--   • transition into status='dead'  → meta.dispositionReason required
--     (dispositionAt stamped if missing)
--   • transition into soft-deleted   → deleted_reason required
-- Emergency bypass for admin surgery: select set_config('dcc.kill_gate','off',true);
create or replace function public.tg_require_kill_reason()
returns trigger language plpgsql security definer set search_path to 'public' as $fn$
begin
  if current_setting('dcc.kill_gate', true) = 'off' then return NEW; end if;
  if NEW.status = 'dead' and OLD.status is distinct from 'dead' then
    if coalesce(NEW.meta->>'dispositionReason','') = '' then
      raise exception 'A reason is required to mark a lead dead. Use the "Why did this lead die?" dialog (it records the reason), or set meta.dispositionReason.';
    end if;
    if coalesce(NEW.meta->>'dispositionAt','') = '' then
      NEW.meta := coalesce(NEW.meta,'{}'::jsonb) || jsonb_build_object('dispositionAt', now()::text);
    end if;
  end if;
  if NEW.deleted_at is not null and OLD.deleted_at is null then
    if coalesce(NEW.deleted_reason,'') = '' then
      raise exception 'A reason is required to delete a lead. Use the Delete dialog (it records the reason), or set deleted_reason.';
    end if;
  end if;
  return NEW;
end $fn$;

drop trigger if exists require_kill_reason on public.deals;
create trigger require_kill_reason
  before update on public.deals
  for each row execute function public.tg_require_kill_reason();
