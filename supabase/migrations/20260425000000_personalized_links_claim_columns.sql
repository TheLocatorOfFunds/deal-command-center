-- Personalized-link claim flow — close the silent-failure bug.
--
-- Background: refundlocators-next/src/app/api/s/claim/route.ts UPDATEs
-- personalized_links.mailing_address + claim_submitted_at on every claim
-- modal submission. Neither column existed → handler returned 500. Front-end
-- caught the error and silently advanced to "done" state. Nathan got no
-- notification. Tonight's 19-text personalized-link blast: any submissions
-- were lost.
--
-- This migration:
--   1. Adds the two missing columns.
--   2. Adds a trigger that fires SMS + email to Nathan when a row's
--      claim_submitted_at flips from NULL to NOT NULL. Mirrors the direct
--      Twilio call in submit-lead/index.ts so both intake paths notify Nathan.
--
-- Prerequisites BEFORE applying this migration:
--   1. Edge Function 'notify-claim-submitted' deployed with verify_jwt=false
--   2. NOTIFY_CLAIM_SUBMITTED_SECRET env var set on the Edge Function
--      (openssl rand -hex 32)
--   3. Same value stored in Vault as 'notify_claim_submitted_secret'
--   4. ANTHROPIC_API_KEY, RESEND_API_KEY, TWILIO_* env vars (already set)

-- ─── 1. Add the missing columns ────────────────────────────────
alter table public.personalized_links
  add column if not exists mailing_address text,
  add column if not exists claim_submitted_at timestamptz;

create index if not exists idx_personalized_links_claim_submitted
  on public.personalized_links(claim_submitted_at desc)
  where claim_submitted_at is not null;

-- ─── 2. Notification trigger ───────────────────────────────────
create or replace function public.notify_personalized_claim_submitted()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  fn_secret text;
  fn_url text := 'https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/notify-claim-submitted';
begin
  -- Only fire on the transition from NULL → NOT NULL (first-time submission).
  -- Resubmissions (claim_submitted_at already set) are no-ops.
  if NEW.claim_submitted_at is null then return NEW; end if;
  if OLD.claim_submitted_at is not null then return NEW; end if;

  begin
    select decrypted_secret into fn_secret from vault.decrypted_secrets
      where name = 'notify_claim_submitted_secret' limit 1;
  exception when others then
    fn_secret := null;
  end;
  if fn_secret is null then return NEW; end if;

  perform net.http_post(
    url := fn_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Notify-Claim-Submitted-Secret', fn_secret
    ),
    body := jsonb_build_object('token', NEW.token)::jsonb
  );
  return NEW;
end;
$$;

drop trigger if exists tg_notify_personalized_claim_submitted on public.personalized_links;
create trigger tg_notify_personalized_claim_submitted
  after update of claim_submitted_at on public.personalized_links
  for each row
  execute function public.notify_personalized_claim_submitted();

comment on function public.notify_personalized_claim_submitted() is
  'Fires when a personalized_links row gets claim_submitted_at set for the first time. Calls the notify-claim-submitted Edge Function which texts + emails Nathan. Mirrors the direct Twilio call in submit-lead/index.ts so both intake paths produce the same alert.';
