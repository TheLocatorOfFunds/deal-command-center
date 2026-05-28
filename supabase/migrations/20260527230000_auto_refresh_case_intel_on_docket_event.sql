-- 2026-05-27 — Auto-refresh case-intel summary when a meaningful docket event lands.
-- Closes #239.
--
-- Companion to abba41c (refresh-on-open in the CaseIntelligence UI). That fix
-- catches a stale brief at the moment a caller OPENS a deal. This trigger
-- keeps the brief fresh even when nobody has opened it yet — it fires
-- generate-case-summary the moment a meaningful event lands in docket_events.
--
-- Why we want this:
--   morning-sweep refreshes case-intel summaries once at 8am ET. If a
--   supplemental-distribution motion lands at 2pm today, the caller's brief
--   doesn't reflect it until tomorrow morning — unless someone happens to
--   open the deal first. This closes that window so the brief is always
--   current for the next caller, regardless of whether anyone opened the
--   deal in between.
--
-- Meaningful events (start narrow; expand by adding to the regex below):
--   event_type or description matches motion / order / decree / confirmation /
--   supplemental_distribution / sheriff_sale / deposit_amount_paid_sheriff /
--   surplus  (case-insensitive substring).
--
-- Skipped:
--   - is_backfill = true  (don't re-fire on Castle's historical replays)
--   - debounce: if deals.meta.case_intel_summary.generated_at is < 5 min old
--     (Castle bulk inserts can cluster — don't burn AI calls in a burst on
--     the same deal)
--
-- Prerequisites (verify before applying):
--   1. generate-case-summary EF deployed with the #241 changes (Justin owns the
--      deploy; commit on the same PR). Until deployed, this trigger will still
--      fire successfully but the brief won't include the new engagement /
--      Lauren signals — graceful degradation.
--   2. vault.decrypted_secrets has an entry name='service_role_key' containing
--      this project's service-role JWT. Already used by other triggers in this
--      repo (lauren-event-router, morning-sweep, intel-sync). Confirmed 2026-05-27.
--
-- Pattern source: this mirrors trigger_attach_docket_pdf (migration
-- 20260424210000) — also a docket_events INSERT trigger that calls an EF via
-- pg_net. Diff: we use Authorization Bearer instead of a custom X-secret header
-- because generate-case-summary's existing Bearer length check accepts the
-- service-role JWT without needing an EF code change.

create or replace function public.trigger_refresh_case_intel_on_docket()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  fn_url           text := 'https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/generate-case-summary';
  service_token    text;
  deal_summary_ts  timestamptz;
  evt              text;
  desc_text        text;
  matched          boolean;
begin
  -- Skip orphan / replayed events.
  if NEW.is_backfill = true or NEW.deal_id is null then return NEW; end if;

  evt       := lower(coalesce(NEW.event_type, ''));
  desc_text := lower(coalesce(NEW.description, ''));

  -- Meaningful-event allowlist (substring regex). Match against event_type
  -- AND description to catch counties that put the signal in either field.
  matched := (
    evt ~ '(motion|order|decree|confirmation|supplemental_distribution|sheriff_sale|deposit_amount_paid_sheriff|surplus)'
    OR desc_text ~ '(motion|order|decree|confirmation|supplemental distribution|sheriff sale|deposit amount paid sheriff|surplus)'
  );
  if not matched then return NEW; end if;

  -- Debounce: skip if a fresh summary already exists for this deal.
  select (d.meta -> 'case_intel_summary' ->> 'generated_at')::timestamptz
    into deal_summary_ts
    from public.deals d
    where d.id = NEW.deal_id;
  if deal_summary_ts is not null and deal_summary_ts > now() - interval '5 minutes' then
    return NEW;
  end if;

  -- Pull the service-role JWT from vault. If it's missing, silently skip
  -- — never let summary-refresh plumbing block a docket_events INSERT.
  begin
    select decrypted_secret into service_token
      from vault.decrypted_secrets
      where name = 'service_role_key'
      limit 1;
  exception when others then
    service_token := null;
  end;
  if service_token is null then return NEW; end if;

  -- Fire generate-case-summary non-blocking via pg_net. The EF writes the
  -- fresh summary to deals.meta.case_intel_summary; the DCC UI's existing
  -- realtime subscription on `deals` will pick it up without a refresh.
  perform net.http_post(
    url := fn_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || service_token
    ),
    body := jsonb_build_object('deal_id', NEW.deal_id)::jsonb
  );

  return NEW;
end;
$$;

drop trigger if exists tg_refresh_case_intel_on_docket on public.docket_events;
create trigger tg_refresh_case_intel_on_docket
  after insert on public.docket_events
  for each row
  execute function public.trigger_refresh_case_intel_on_docket();

comment on function public.trigger_refresh_case_intel_on_docket() is
  'Fires generate-case-summary when a meaningful (motion/order/decree/sale/surplus) docket event lands, keeping the AI brief fresh between morning-sweep runs. 5-min debounce per deal via deals.meta.case_intel_summary.generated_at. Skips backfill rows. Non-blocking via pg_net — the underlying docket_events INSERT succeeds even if the EF call fails. Reads service-role JWT from vault. Closes #239.';
