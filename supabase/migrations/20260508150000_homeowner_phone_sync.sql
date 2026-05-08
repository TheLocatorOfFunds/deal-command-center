-- 2026-05-08 — Auto-queue silent-skip fix.
--
-- Eric flagged 2026-05-08 that Charlotte Morrow was Mark Prepped but
-- never entered the outreach drafts queue, despite all 5 SOP criteria
-- being met. Investigation surfaced a deeper architectural gap:
--
-- 1. dealMetaPhone (used by prepMissing + markPrepped auto-queue, after
--    this morning's commit dfd9d57) only reads from deal.meta. It
--    accepts 4 key variants — but if the phone lives ONLY on the
--    contacts table (not in meta at all), the helper returns null and
--    the deal silently never enters the outreach queue. Charlotte +
--    5 other deals were in that state.
--
-- 2. 247 of 406 contact_deals rows have relationship=NULL. The UI
--    displays HOMEOWNER/CHILD pills by reading contacts.kind instead,
--    so the gap is invisible — but anything that genuinely gates on
--    contact_deals.relationship='homeowner' (per-family-member URL
--    minting, the research-agent code) silently misfires on those 247.
--
-- Affected prepped A-tier deals (silently skipped from outreach right
-- now, confirmed via JS console probe):
--   - Richard Mikol  (surplus-moisdfo0dyq8) — phone (216) 577-0123
--   - Charlotte Morrow (surplus-moism04rxdur) — phone 937-561-4831
--   - Trevor Mccain (sf-trevor) — phone 818-720-2425
-- Plus 1 C-tier prepped + 1 unprepped + 1 deleted = 6 total affected.

-- ── Step 1: Backfill contact_deals.relationship from contacts.kind
-- where currently null. Mirrors the implicit invariant the UI relies
-- on. Idempotent — re-running finds zero rows once filled.
update public.contact_deals cd
set relationship = c.kind
from public.contacts c
where cd.contact_id = c.id
  and cd.relationship is null
  and c.kind is not null;

-- ── Step 2: Backfill deal.meta.homeownerPhone from the linked
-- homeowner contact's FIRST phone. contacts.phone may be a comma-
-- separated CSV when the homeowner has multiple numbers; meta stores
-- a single phone (downstream outreach_queue + Twilio expect a single
-- E.164-ish number, not a CSV). Only fills where meta is empty across
-- all 4 known variants — preserves any manual override.
with homeowner_phones as (
  select distinct on (cd.deal_id)
    cd.deal_id,
    trim(split_part(c.phone, ',', 1)) as first_phone
  from public.contact_deals cd
  join public.contacts c on c.id = cd.contact_id
  where c.kind = 'homeowner'
    and c.phone is not null
    and trim(c.phone) <> ''
  order by cd.deal_id, cd.created_at  -- earliest link wins if multiple
)
update public.deals d
set meta = coalesce(d.meta, '{}'::jsonb) || jsonb_build_object('homeownerPhone', hp.first_phone)
from homeowner_phones hp
where d.id = hp.deal_id
  and (d.meta->>'homeownerPhone' is null or d.meta->>'homeownerPhone' = '')
  and (d.meta->>'phone' is null or d.meta->>'phone' = '')
  and (d.meta->>'contactPhone' is null or d.meta->>'contactPhone' = '')
  and (d.meta->>'homeowner_phone' is null or d.meta->>'homeowner_phone' = '')
  and hp.first_phone is not null
  and hp.first_phone <> '';

-- ── Step 3: Trigger — sync meta.homeownerPhone when a homeowner
-- contact's phone (or kind) is updated. Only fills meta if currently
-- empty so manual overrides aren't clobbered.
create or replace function public.sync_homeowner_phone_on_contact_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.kind is distinct from 'homeowner' then return NEW; end if;
  if NEW.phone is null or trim(NEW.phone) = '' then return NEW; end if;
  update public.deals d
  set meta = coalesce(d.meta, '{}'::jsonb) || jsonb_build_object('homeownerPhone', trim(split_part(NEW.phone, ',', 1)))
  from public.contact_deals cd
  where cd.contact_id = NEW.id
    and cd.deal_id = d.id
    and (d.meta->>'homeownerPhone' is null or d.meta->>'homeownerPhone' = '')
    and (d.meta->>'phone' is null or d.meta->>'phone' = '')
    and (d.meta->>'contactPhone' is null or d.meta->>'contactPhone' = '')
    and (d.meta->>'homeowner_phone' is null or d.meta->>'homeowner_phone' = '');
  return NEW;
end;
$$;

drop trigger if exists tg_sync_homeowner_phone_on_contact_update on public.contacts;
create trigger tg_sync_homeowner_phone_on_contact_update
  after insert or update of phone, kind on public.contacts
  for each row
  execute function public.sync_homeowner_phone_on_contact_update();

-- ── Step 4: Trigger — sync meta.homeownerPhone when a contact is
-- linked (or relationship updated) on a deal. Mirror image of step 3.
create or replace function public.sync_homeowner_phone_on_contact_link()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phone text;
  v_kind text;
begin
  select phone, kind into v_phone, v_kind
  from public.contacts where id = NEW.contact_id;
  if v_kind is distinct from 'homeowner' then return NEW; end if;
  if v_phone is null or trim(v_phone) = '' then return NEW; end if;
  update public.deals d
  set meta = coalesce(d.meta, '{}'::jsonb) || jsonb_build_object('homeownerPhone', trim(split_part(v_phone, ',', 1)))
  where d.id = NEW.deal_id
    and (d.meta->>'homeownerPhone' is null or d.meta->>'homeownerPhone' = '')
    and (d.meta->>'phone' is null or d.meta->>'phone' = '')
    and (d.meta->>'contactPhone' is null or d.meta->>'contactPhone' = '')
    and (d.meta->>'homeowner_phone' is null or d.meta->>'homeowner_phone' = '');
  return NEW;
end;
$$;

drop trigger if exists tg_sync_homeowner_phone_on_contact_link on public.contact_deals;
create trigger tg_sync_homeowner_phone_on_contact_link
  after insert or update on public.contact_deals
  for each row
  execute function public.sync_homeowner_phone_on_contact_link();

-- ── Step 5: Retroactively queue Day-0 outreach for any A/B-tier
-- prepped deal that now has meta.homeownerPhone but no active
-- outreach_queue row. This catches the 3 silently-skipped A-tier
-- deals (Richard, Charlotte, Trevor) plus any other prepped lead the
-- bug skipped. Mirrors markPrepped's gate logic exactly:
--   • prepped_at NOT NULL + not deleted
--   • tier in (A, B)
--   • status not in (closed, dead, recovered)
--   • meta.homeownerPhone now set
--   • no existing active outreach_queue row
--   • no DNC homeowner contact (checked by linked contact, not phone
--     string match — contacts.phone is a CSV, meta is one number)
insert into public.outreach_queue (deal_id, contact_phone, cadence_day, status, scheduled_for)
select
  d.id,
  d.meta->>'homeownerPhone',
  0,
  'queued',
  now()
from public.deals d
where d.prepped_at is not null
  and d.deleted_at is null
  and d.lead_tier in ('A', 'B')
  and d.status not in ('closed', 'dead', 'recovered')
  and d.meta->>'homeownerPhone' is not null
  and trim(d.meta->>'homeownerPhone') <> ''
  and not exists (
    select 1 from public.outreach_queue oq
    where oq.deal_id = d.id
      and oq.status not in ('skipped', 'cancelled', 'failed', 'sent')
  )
  and not exists (
    select 1 from public.contact_deals cd
    join public.contacts c on c.id = cd.contact_id
    where cd.deal_id = d.id
      and c.kind = 'homeowner'
      and c.do_not_text = true
  );

-- ── Audit query (NOT executed, for verification after applying)
--
-- Confirm the affected 3 A-tier deals now have meta.homeownerPhone
-- and a queued outreach_queue row:
--
-- select d.id, d.name, d.lead_tier, d.meta->>'homeownerPhone' as phone,
--   oq.status, oq.cadence_day, oq.scheduled_for
-- from public.deals d
-- left join public.outreach_queue oq on oq.deal_id = d.id
--   and oq.status not in ('skipped','cancelled','failed','sent')
-- where d.id in ('surplus-moism04rxdur', 'surplus-moisdfo0dyq8', 'sf-trevor');
