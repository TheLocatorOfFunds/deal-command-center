-- 2026-05-08 — Audit remediation: deceased-sync, stale-queue sweeper,
-- orphan-test-link cleanup, deceased-outreach safety cancel.
--
-- Surfaced by tonight's full-system audit. Bundles 4 surgical fixes
-- and 2 structural triggers/cron-jobs that close silent failure
-- patterns systemic to the prep → outreach pipeline.
--
-- Findings + responses:
--
-- 1. Two deceased homeowners are queued for Day-0 outreach RIGHT NOW.
--    Lindon Phillips (sf-phillips) and Leroy Turner Jr (sf-turnerjr)
--    each have an active outreach_queue row that would text the
--    deceased person directly. Cancel both as a safety move.
--
-- 2. One outreach_queue row stuck "pending" for 9 days (Kemper Ansel,
--    deal moved to 'filed' but the queue row never resolved). Cancel
--    it.
--
-- 3. Same architectural drift pattern as today's phone fix, now for
--    deceased: 24 deals have a homeowner contact flagged
--    contacts.deceased=true, but deal.meta.deceased and death_signal
--    are NULL. dealMetaDeceased() reader → returns false → no 🕊
--    badge, no compose-flow warning, no auto-queue gate.
--    Backfill + sync trigger mirrors today's phone solution.
--
-- 4. Stale outreach_queue zombie rows: 1 today, but no cleanup
--    process exists. Add a sweeper function + pg_cron job that
--    cancels any queue row stuck in queued/pending/generating for
--    >14 days.
--
-- 5. 20 orphan personalized_links (deal_id IS NULL). 19 are zero-view
--    test data; 1 (Nathan Johnson) is Nathan's own portal-flow test
--    (source='manual-test'). All safe to delete.

-- ════════════════════════════════════════════════════════════════════
-- A) SAFETY CANCEL — 2 deceased homeowners + 1 zombie queue row
-- ════════════════════════════════════════════════════════════════════
update public.outreach_queue
set status = 'cancelled',
    skipped_reason = 'homeowner deceased — safety cancel via 2026-05-08 audit'
where deal_id in ('sf-phillips', 'sf-turnerjr')
  and status not in ('skipped', 'cancelled', 'failed', 'sent');

update public.outreach_queue
set status = 'cancelled',
    skipped_reason = 'stuck pending >9 days, deal moved past new-lead — auto-clean via 2026-05-08 audit'
where id = 'b39a5884-e154-4d7f-b433-a52ccb508327'
  and status = 'pending';

-- ════════════════════════════════════════════════════════════════════
-- B) DECEASED SYNC — backfill 24 drift deals + sync trigger going forward
-- ════════════════════════════════════════════════════════════════════

-- Backfill: any deal with a homeowner contact flagged deceased=true
-- but deal.meta.deceased not set → propagate.
update public.deals d
set meta = coalesce(d.meta, '{}'::jsonb) || jsonb_build_object(
  'deceased', true,
  'deceased_at', coalesce(d.meta->>'deceased_at', now()::text),
  'deceased_source', coalesce(d.meta->>'deceased_source', 'contact-sync-backfill 2026-05-08')
)
from public.contact_deals cd
join public.contacts c on c.id = cd.contact_id
where cd.deal_id = d.id
  and c.kind = 'homeowner'
  and c.deceased = true
  and (d.meta->>'deceased' is null or d.meta->>'deceased' = 'false')
  and (d.death_signal is null or d.death_signal = false)
  and d.deleted_at is null;

-- Trigger function: when a homeowner contact's deceased flag flips,
-- propagate to every linked deal's meta.deceased.
create or replace function public.sync_homeowner_deceased_on_contact_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.kind is distinct from 'homeowner' then return NEW; end if;
  -- Only react when the deceased flag actually changed
  if NEW.deceased is not distinct from OLD.deceased then return NEW; end if;
  if NEW.deceased = true then
    update public.deals d
    set meta = coalesce(d.meta, '{}'::jsonb) || jsonb_build_object(
      'deceased', true,
      'deceased_at', coalesce(d.meta->>'deceased_at', coalesce(NEW.deceased_at::text, now()::text)),
      'deceased_source', coalesce(d.meta->>'deceased_source', coalesce(NEW.deceased_source, 'contact-sync'))
    )
    from public.contact_deals cd
    where cd.contact_id = NEW.id and cd.deal_id = d.id and d.deleted_at is null;
  end if;
  -- Note: when deceased flips false, we do NOT auto-clear deal.meta.deceased.
  -- A "no, they're alive" correction is a manual decision per deal.
  return NEW;
end;
$$;

drop trigger if exists tg_sync_homeowner_deceased_on_contact_update on public.contacts;
create trigger tg_sync_homeowner_deceased_on_contact_update
  after update of deceased, kind on public.contacts
  for each row
  execute function public.sync_homeowner_deceased_on_contact_update();

-- Trigger function: when a deceased homeowner contact is linked to a
-- deal, propagate at link time too.
create or replace function public.sync_homeowner_deceased_on_contact_link()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deceased boolean;
  v_kind text;
  v_deceased_at timestamptz;
  v_deceased_source text;
begin
  select kind, deceased, deceased_at, deceased_source
    into v_kind, v_deceased, v_deceased_at, v_deceased_source
  from public.contacts where id = NEW.contact_id;
  if v_kind is distinct from 'homeowner' then return NEW; end if;
  if v_deceased is not true then return NEW; end if;
  update public.deals d
  set meta = coalesce(d.meta, '{}'::jsonb) || jsonb_build_object(
    'deceased', true,
    'deceased_at', coalesce(d.meta->>'deceased_at', coalesce(v_deceased_at::text, now()::text)),
    'deceased_source', coalesce(d.meta->>'deceased_source', coalesce(v_deceased_source, 'contact-link-sync'))
  )
  where d.id = NEW.deal_id and d.deleted_at is null;
  return NEW;
end;
$$;

drop trigger if exists tg_sync_homeowner_deceased_on_contact_link on public.contact_deals;
create trigger tg_sync_homeowner_deceased_on_contact_link
  after insert or update on public.contact_deals
  for each row
  execute function public.sync_homeowner_deceased_on_contact_link();

-- ════════════════════════════════════════════════════════════════════
-- C) STALE-QUEUE SWEEPER — function + pg_cron daily job
-- ════════════════════════════════════════════════════════════════════
-- Cancels any outreach_queue row stuck in queued/pending/generating
-- for >14 days. These are zombies — usually deals that moved past
-- new-lead status (signed, filed, recovered) without their queued
-- draft ever firing or being cancelled. Without a sweeper they
-- accumulate forever.

create or replace function public.sweep_stale_outreach_queue()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  with cancelled as (
    update public.outreach_queue
    set status = 'cancelled',
        skipped_reason = 'stale — auto-cancelled by daily sweep (>14 days in pre-send state)'
    where status in ('queued', 'pending', 'generating')
      and created_at < now() - interval '14 days'
    returning id
  )
  select count(*) into v_count from cancelled;
  return v_count;
end;
$$;

-- Schedule: daily at 09:00 UTC (5am EDT / 4am EST) — well before
-- the morning sweep email digest at 12:00 UTC so the digest sees
-- a clean queue.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    -- Drop existing schedule if present
    perform cron.unschedule(jobid)
      from cron.job where jobname = 'sweep-stale-outreach-queue';
    perform cron.schedule(
      'sweep-stale-outreach-queue',
      '0 9 * * *',
      $sql$select public.sweep_stale_outreach_queue();$sql$
    );
  end if;
end $$;

-- ════════════════════════════════════════════════════════════════════
-- D) ORPHAN PERSONALIZED_LINKS CLEANUP
-- ════════════════════════════════════════════════════════════════════
-- 20 orphan rows total (deal_id IS NULL). 1 is Nathan's manual-test
-- submission (source='manual-test', view_count=3). 19 are zero-view
-- dev/test data. Delete the lot — Nathan has confirmed nothing of
-- value depends on these.

delete from public.personalized_links
where deal_id is null;

-- ════════════════════════════════════════════════════════════════════
-- E) VERIFY — should show:
--    • 0 active outreach for sf-phillips / sf-turnerjr
--    • 24+ deals now flagged meta.deceased=true (was 12 before)
--    • 0 orphan personalized_links
--    • sweep function exists
-- ════════════════════════════════════════════════════════════════════
select
  (select count(*) from public.outreach_queue
    where deal_id in ('sf-phillips','sf-turnerjr')
      and status not in ('skipped','cancelled','failed','sent')) as deceased_in_queue_should_be_0,
  (select count(*) from public.deals
    where (meta->>'deceased')::boolean = true and deleted_at is null) as deals_flagged_deceased,
  (select count(*) from public.personalized_links where deal_id is null) as orphan_links_should_be_0,
  (select 1 from pg_proc where proname = 'sweep_stale_outreach_queue' limit 1) as sweep_function_exists,
  (select 1 from pg_proc where proname = 'sync_homeowner_deceased_on_contact_update' limit 1) as deceased_trigger_exists;
