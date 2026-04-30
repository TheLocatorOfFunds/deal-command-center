-- Drop the secret check from the attach-docket-pdf trigger.
--
-- The trigger from 20260424210000_docket_auto_attach_pdf.sql tried to read
-- 'attach_docket_pdf_secret' from pgsodium vault, which was never set in
-- production — so for the last several days, every Castle docket event
-- silently skipped the PDF fetch (10/10 recent events with document_url
-- ended up with no stored copy).
--
-- Per Nathan 2026-04-30: PDFs are required on every new event. The EF
-- has been refactored to drop the matching header check (only operates
-- on valid event_ids that already exist in our DB — no abuse vector
-- worth gating). Trigger now calls without the X-Attach-Docket-PDF-Secret
-- header.

create or replace function public.trigger_attach_docket_pdf()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  fn_url text := 'https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/attach-docket-pdf';
begin
  if NEW.document_url is null or NEW.is_backfill = true or NEW.document_ocr_id is not null then
    return NEW;
  end if;

  perform net.http_post(
    url := fn_url,
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := jsonb_build_object('docket_event_id', NEW.id)::jsonb
  );
  return NEW;
end;
$$;

-- Trigger itself stays exactly the same; just the function body changed.
-- Idempotent re-create to be safe.
drop trigger if exists tg_attach_docket_pdf on public.docket_events;
create trigger tg_attach_docket_pdf
  after insert on public.docket_events
  for each row
  execute function public.trigger_attach_docket_pdf();

comment on function public.trigger_attach_docket_pdf() is
  'Fires attach-docket-pdf Edge Function for every new docket event with document_url. Skips backfill rows and already-attached events. No secret — EF validates the event_id is real and only fetches if document_url is set.';
