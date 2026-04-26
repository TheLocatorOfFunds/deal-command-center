-- Outreach pipeline sync — Monday-launch infra (Nathan's session)
--
-- Cross-cutting migration that wires up three pieces Justin's session would
-- otherwise need to ship. Documented here so Justin's Claude sees them on
-- the next git pull. None of this changes the shape of his existing
-- outreach_queue / messages_outbound / contacts code paths — purely additive.
--
-- Pieces:
--   1. Sync trigger: personalized_links.token → deals.refundlocators_token
--      whenever Castle (or anyone) sets personalized_links.deal_id. Lets
--      Justin's existing generate-outreach read deals.refundlocators_token
--      without a workflow change.
--   2. Cadence engine table column + index — outreach_queue.scheduled_for
--      already exists per Justin's PR #12; here we just add an index for
--      the cron walker's hot query.
--   3. fire_scheduled_outreach() function + pg_cron schedule — every 15 min,
--      walk outreach_queue for cadence_day >= 1 + scheduled_for <= now() +
--      status='pending' + DNC-respecting, fire dispatch-cadence-message.
--
-- The intro draft (cadence_day=0) is INTENTIONALLY excluded from auto-send
-- per Nathan's flow: Monday morning he hand-clicks each first text from
-- the Outreach view's AutomationsQueue. Drips ≥ Day 1 auto-send.
--
-- 'Send' here means: enqueue the SMS via send-sms. Nathan is the human
-- physically operating his iPhone via DCC; this code is a typing-assistant.

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

-- ── 1. Sync personalized_links.token → deals.refundlocators_token ────────

create or replace function public.sync_refundlocators_token()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Fires when personalized_links.deal_id flips from NULL → NOT NULL,
  -- OR when token changes on a row that already has a deal_id.
  if NEW.deal_id is null then return NEW; end if;
  if TG_OP = 'UPDATE' and OLD.deal_id = NEW.deal_id and OLD.token = NEW.token then
    return NEW;
  end if;

  update public.deals
     set refundlocators_token = NEW.token
   where id = NEW.deal_id::text
     and (refundlocators_token is null or refundlocators_token != NEW.token);

  return NEW;
end;
$$;

drop trigger if exists tg_sync_refundlocators_token on public.personalized_links;
create trigger tg_sync_refundlocators_token
  after insert or update of deal_id, token on public.personalized_links
  for each row
  execute function public.sync_refundlocators_token();

comment on function public.sync_refundlocators_token() is
  'Keeps deals.refundlocators_token in lockstep with personalized_links.token whenever Castle (or anyone) connects a link to a deal. Lets generate-outreach read the token off deals without a join.';

-- ── 2. Index for cadence cron walker hot query ────────────────────────────

create index if not exists idx_outreach_queue_due
  on public.outreach_queue (scheduled_for)
  where status = 'pending' and cadence_day >= 1;

-- ── 3. Cadence engine cron job ────────────────────────────────────────────

create or replace function public.fire_scheduled_outreach()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  rec record;
  fn_secret text;
  fn_url text := 'https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/dispatch-cadence-message';
begin
  select decrypted_secret into fn_secret from vault.decrypted_secrets
    where name = 'cadence_engine_secret' limit 1;
  if fn_secret is null then return; end if;

  for rec in
    select q.id
    from public.outreach_queue q
    where q.status = 'pending'
      and q.scheduled_for is not null
      and q.scheduled_for <= now()
      and q.cadence_day >= 1                 -- intro is human-gated
      and q.draft_body is not null
      and not exists (
        select 1 from public.contacts c
        where c.phone = q.contact_phone
          and c.do_not_text = true
      )
    order by q.scheduled_for asc
    limit 100
  loop
    perform net.http_post(
      url := fn_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'X-Cadence-Secret', fn_secret
      ),
      body := jsonb_build_object('queue_id', rec.id)::jsonb
    );
  end loop;
end;
$$;

do $$ begin
  if exists (select 1 from cron.job where jobname = 'outreach-cadence') then
    perform cron.unschedule('outreach-cadence');
  end if;
end $$;

select cron.schedule(
  'outreach-cadence',
  '*/15 * * * *',
  $sql$select public.fire_scheduled_outreach()$sql$
);

comment on function public.fire_scheduled_outreach() is
  'Every 15 min: drains outreach_queue rows where status=pending + cadence_day>=1 + scheduled_for<=now() + contact not on DNC. Calls dispatch-cadence-message Edge Function for each. Cap 100/run to avoid hammering Twilio. Intro (cadence_day=0) is excluded — that requires Nathan-approved click-to-send from the Outreach view.';
