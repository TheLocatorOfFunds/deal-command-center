-- 2026-05-26 — Log meaningful personalized-link opens to the deal activity feed.
--
-- Closes DCC #223. The 🔥 "Lead Engagement" strip (Attention view) already surfaces
-- WHO opened their /s/<token> link, reading v_personalized_link_engagement. This adds
-- the other half Nathan asked for: a row on the DEAL TIMELINE (and the Today "Team
-- Activity" feed — both already realtime-subscribed to `activity`) when a real
-- recipient opens their link, so the open is part of the case history, not just a
-- transient dashboard signal.
--
-- Fires on personalized_link_views INSERT. The refundlocators-next /s/[token] page
-- handler writes those rows via the service client.
--
-- "Meaningful moments only" (per Nathan): skip team/preview views, and dedupe
-- refresh-spam — log the FIRST external open, or a re-open after a >24h gap, but not a
-- reload within 24h. So a homeowner refreshing 5× = at most one timeline row.
--
-- Forward-only (won't backfill existing views). Exception-safe: a logging failure
-- never blocks the underlying view insert. user_id is NULL + visibility=['team']
-- (system-authored, internal-only — mirrors the homeowner-intake activity row).

create or replace function public.tg_log_link_open_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $func$
declare
  prev_latest timestamptz;
  pl          record;
  nm          text;
  verb        text;
begin
  -- Real recipient views only — never team/preview clicks.
  if coalesce(new.is_team_view, false) then
    return new;
  end if;

  -- Most recent PRIOR external view for this token (strictly before this row).
  select max(v.viewed_at)
    into prev_latest
  from public.personalized_link_views v
  where v.token = new.token
    and coalesce(v.is_team_view, false) = false
    and v.viewed_at < new.viewed_at;

  if prev_latest is null then
    verb := 'opened their case link';
  elsif new.viewed_at - prev_latest > interval '24 hours' then
    verb := 'opened their case link again';
  else
    return new;  -- reload within 24h — not a "meaningful moment", skip
  end if;

  -- Resolve the deal + recipient name from the personalized link.
  -- personalized_links.deal_id is TEXT (e.g. 'sf-mica'); activity.deal_id is TEXT too.
  select pl2.deal_id, pl2.first_name, pl2.last_name
    into pl
  from public.personalized_links pl2
  where pl2.token = new.token
  limit 1;

  -- Orphan link (no deal attached) → nothing to attach a timeline row to.
  if pl.deal_id is null then
    return new;
  end if;

  nm := nullif(btrim(coalesce(pl.first_name, '') || ' ' || coalesce(pl.last_name, '')), '');

  begin
    insert into public.activity (deal_id, user_id, action, visibility)
    values (
      pl.deal_id,
      null,
      '🔗 ' || coalesce(nm, 'Lead') || ' ' || verb,
      array['team']
    );
  exception when others then
    -- Best-effort: never let activity logging block the link-view insert.
    null;
  end;

  return new;
end;
$func$;

drop trigger if exists tg_link_view_activity on public.personalized_link_views;
create trigger tg_link_view_activity
  after insert on public.personalized_link_views
  for each row
  execute function public.tg_log_link_open_activity();

comment on function public.tg_log_link_open_activity() is
  'Logs a 🔗 activity row on the deal when a real recipient opens their /s/<token> link (first open, or re-open after >24h; team/preview + refresh-spam skipped). Closes #223.';
