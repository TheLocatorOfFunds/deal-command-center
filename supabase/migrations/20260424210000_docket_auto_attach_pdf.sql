-- Auto-attach court PDFs to deals when a new docket event lands.
--
-- When docket-webhook inserts a new docket_event with document_url set:
--   1. This trigger fires via pg_net to attach-docket-pdf Edge Function
--   2. Function fetches the PDF, uploads to deal-docs storage
--   3. Creates a documents row linked to the deal (triggers Claude Vision OCR)
--   4. Back-links via docket_events.document_ocr_id
--
-- Skipped for:
--   - Events without document_url (nothing to fetch)
--   - Backfill events (don't retroactively fetch 857 old PDFs)
--   - Events already attached (document_ocr_id is not null — idempotent)
--
-- Prerequisites:
--   1. Edge Function 'attach-docket-pdf' deployed with verify_jwt=false
--   2. ATTACH_DOCKET_PDF_SECRET env var set on the Edge Function
--      (openssl rand -hex 32)
--   3. Same value stored in vault as 'attach_docket_pdf_secret'

create or replace function public.trigger_attach_docket_pdf()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  fn_secret text;
  fn_url text := 'https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/attach-docket-pdf';
begin
  if NEW.document_url is null or NEW.is_backfill = true or NEW.document_ocr_id is not null then
    return NEW;
  end if;

  begin
    select decrypted_secret into fn_secret from vault.decrypted_secrets
      where name = 'attach_docket_pdf_secret' limit 1;
  exception when others then
    fn_secret := null;
  end;
  if fn_secret is null then return NEW; end if;

  perform net.http_post(
    url := fn_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Attach-Docket-PDF-Secret', fn_secret
    ),
    body := jsonb_build_object('docket_event_id', NEW.id)::jsonb
  );
  return NEW;
end;
$$;

drop trigger if exists tg_attach_docket_pdf on public.docket_events;
create trigger tg_attach_docket_pdf
  after insert on public.docket_events
  for each row
  execute function public.trigger_attach_docket_pdf();

comment on function public.trigger_attach_docket_pdf() is
  'Fires attach-docket-pdf Edge Function for every new docket event with a document_url. Skips backfill rows and already-attached events. Non-blocking via pg_net; webhook insert succeeds even if PDF fetch fails.';
