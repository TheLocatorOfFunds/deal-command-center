-- Auto-queue an iMessage capability probe whenever a contact gets a new
-- (or changed) phone number. Saves Eric from clicking "Probe" 150+ times
-- on the GHL family-contact backlog.
--
-- Per the Justin spec — JUSTIN_PHONE_INTEL_PROBE_SPEC.md "Auto-probe on
-- contact insert (recommended)". The trigger calls the existing
-- public.queue_phone_probe(p_phone_e164) RPC, which UPSERTs the
-- phone_intel row and flips status='queued'. Mac Mini bridge picks up
-- queued rows on its poll cycle.
--
-- Phone normalization is inlined (10-digit → +1XXX, 11-digit-leading-1
-- → +XXX, otherwise pass through). Mirrors src/app.jsx normalizePhone.
-- Skips empty / clearly-invalid phones.

create or replace function public.tg_auto_queue_phone_probe()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_digits text;
  v_e164 text;
  v_should boolean := false;
begin
  -- Only act on actual changes
  if TG_OP = 'INSERT' then
    v_should := NEW.phone is not null and length(trim(NEW.phone)) > 0;
  elsif TG_OP = 'UPDATE' then
    v_should := NEW.phone is not null
                and length(trim(NEW.phone)) > 0
                and NEW.phone is distinct from OLD.phone;
  end if;

  if not v_should then return NEW; end if;

  v_digits := regexp_replace(NEW.phone, '\D', '', 'g');

  -- Normalize to E.164. Skip if we can't form a valid US number — keeps
  -- the probe queue free of garbage like "555-1234" stub data.
  if length(v_digits) = 10 then
    v_e164 := '+1' || v_digits;
  elsif length(v_digits) = 11 and substring(v_digits, 1, 1) = '1' then
    v_e164 := '+' || v_digits;
  else
    return NEW;  -- non-US or malformed; skip
  end if;

  -- Fire the queue RPC. UPSERT semantics — safe to call repeatedly.
  -- Wrapped in a no-op exception block so a probe-queue failure never
  -- blocks the contact insert/update itself.
  begin
    perform public.queue_phone_probe(v_e164);
  exception when others then
    -- silent: contact write succeeds; probe just won't run
    null;
  end;

  return NEW;
end;
$$;

drop trigger if exists tg_auto_queue_phone_probe on public.contacts;
create trigger tg_auto_queue_phone_probe
  after insert or update of phone on public.contacts
  for each row
  execute function public.tg_auto_queue_phone_probe();

comment on function public.tg_auto_queue_phone_probe() is
  'Auto-queues an iMessage probe (via public.queue_phone_probe) whenever contacts.phone is inserted or changed. Normalizes US numbers to E.164; skips non-US / malformed.';

-- One-shot backfill: queue probes for every existing contact with a
-- non-null phone that doesn't already have a phone_intel row. Caps at
-- 500 per migration run so we don't flood the bridge in one go.
do $$
declare
  v_count int;
begin
  with backfill as (
    select distinct on (digits)
      case
        when length(digits) = 10 then '+1' || digits
        when length(digits) = 11 and substring(digits, 1, 1) = '1' then '+' || digits
        else null
      end as e164
    from (
      select regexp_replace(phone, '\D', '', 'g') as digits
      from public.contacts
      where phone is not null and length(trim(phone)) > 0
    ) src
    where length(digits) in (10, 11)
    limit 500
  )
  insert into public.phone_intel (phone_e164, status, requested_at)
  select e164, 'queued', now()
  from backfill
  where e164 is not null
  on conflict (phone_e164) do nothing;
  get diagnostics v_count = row_count;
  raise notice 'Backfilled % probe requests', v_count;
end $$;
