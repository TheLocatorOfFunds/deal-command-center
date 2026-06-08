-- Anthropic credit/billing canary + alarm (Nathan 2026-06-08: "add a low-balance
-- alarm so the AI never silently flatlines again").
--
-- WHY: On 2026-06-05 the Anthropic account behind the shared ANTHROPIC_API_KEY
-- ran out of prepaid credits. Every AI Edge Function (generate-case-summary,
-- generate-outreach, all lauren-*, morning-sweep, monday-memo, castle-health-
-- daily, summarize-call, ...) started returning the opaque "Claude API failed"
-- 502 — and NOTHING alerted anyone. Nathan found it 3 days later by clicking the
-- Case Intelligence panel. This adds an active daily canary that exercises the
-- real AI path end-to-end and raises an in-app system alert + a founder email
-- the moment the API stops working (billing exhaustion, auth, retired model, or
-- a hard outage).
--
-- HOW: two pg_cron jobs.
--   * fire_anthropic_canary()  POSTs to the generate-case-summary EF (which holds
--     the Anthropic key — so we DON'T need the key in Vault) for a real deal, via
--     pg_net (async). Records the request id.
--   * check_anthropic_canary() runs 15 min later, reads the pg_net response:
--     HTTP 200 = healthy; anything else / "Claude API failed" = AI is down ->
--     report_system_alert() (deduped by fingerprint) + a Resend email to the
--     founders, with the extracted Anthropic reason.
-- Reuses existing get_resend_api_key() + report_system_alert(); adds NO new Edge
-- Function (EF deploys are IP-allowlist gated, so a SQL-native canary is the only
-- thing this session can ship end-to-end).
--
-- COST: one case-summary generation/day when healthy (~cents); zero/charge-free
-- when down (the failing call spends no tokens). Detection latency <= ~24h, vs
-- the 3 days it took unaided.
--
-- ⚠ Justin: adds two cron jobs + sends a founder alert email via Resend on AI
-- outage. Does NOT touch the SMS/outreach send paths.

-- ── State / audit table — one row per canary fire ────────────────────────────
create table if not exists public.ops_anthropic_canary (
  id             bigint generated always as identity primary key,
  fired_at       timestamptz not null default now(),
  request_id     bigint,                 -- pg_net request id (= net._http_response.id)
  deal_id        text,
  checked        boolean not null default false,
  ok             boolean,
  status_code    int,
  failure_reason text,
  alerted_at     timestamptz             -- when the founder email went out (dedupe/visibility)
);
comment on table public.ops_anthropic_canary is
  'Daily Anthropic-API health canary (fire+check). Added 2026-06-08 after the silent credit-exhaustion outage.';

alter table public.ops_anthropic_canary enable row level security;
drop policy if exists ops_anthropic_canary_admin_all on public.ops_anthropic_canary;
create policy ops_anthropic_canary_admin_all on public.ops_anthropic_canary
  for all using (public.is_admin()) with check (public.is_admin());

-- ── FIRE: kick off one real AI call via the EF ───────────────────────────────
create or replace function public.fire_anthropic_canary()
returns bigint
language plpgsql
security definer
set search_path = public, net
as $fire$
declare
  -- DCC publishable anon key (public; same key the browser uses). The EF auth
  -- gate only requires a Bearer token of length >= 20.
  v_anon text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJjZmFhc2hrZnB1cmt2dG1zbWViIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY0MjkxMDQsImV4cCI6MjA5MjAwNTEwNH0.ZloapZd-pioCsXEpiV-mDaYgQhioNHk2oa5t-QO2WfU';
  v_deal text;
  v_req  bigint;
begin
  -- Canary a real, previously-working deal (freshest cached summary). When
  -- healthy the EF just refreshes that one summary — harmless (morning-sweep
  -- refreshes summaries daily anyway). When down, the call is a charge-free 502.
  select id into v_deal from public.deals
   where meta ? 'case_intel_summary'
   order by (meta->'case_intel_summary'->>'generated_at') desc nulls last
   limit 1;
  if v_deal is null then
    select id into v_deal from public.deals order by id limit 1;
  end if;
  if v_deal is null then
    return null;  -- no deals to canary
  end if;

  select net.http_post(
    url := 'https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/generate-case-summary',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_anon,
      'apikey', v_anon
    ),
    body := jsonb_build_object('deal_id', v_deal),
    timeout_milliseconds := 30000
  ) into v_req;

  insert into public.ops_anthropic_canary (request_id, deal_id) values (v_req, v_deal);
  return v_req;
end;
$fire$;

-- ── CHECK: read the response, alert if the AI path is broken ──────────────────
create or replace function public.check_anthropic_canary(p_notify boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public, net
as $check$
declare
  r        record;
  v_resp   record;
  v_ok     boolean;
  v_status int;
  v_reason text;
  v_inner  text;
  v_body   jsonb;
  v_html   text;
  v_resend text;
begin
  -- Most recent unchecked canary from the last 2 hours.
  select * into r from public.ops_anthropic_canary
   where checked = false and fired_at > now() - interval '2 hours'
   order by fired_at desc limit 1;
  if not found then
    return jsonb_build_object('status','no_pending_canary');
  end if;

  select status_code, content, error_msg into v_resp
    from net._http_response where id = r.request_id;
  if not found then
    return jsonb_build_object('status','response_not_ready','request_id', r.request_id);
  end if;

  v_status := v_resp.status_code;
  -- Healthy = HTTP 200 (EF returns {text,...}) with no pg_net transport error.
  v_ok := (v_status = 200) and (v_resp.error_msg is null);

  if not v_ok then
    -- Pull a human reason out of the EF envelope {error, detail:'<anthropic json>'}.
    begin
      v_body := v_resp.content::jsonb;
      begin
        v_inner := (v_body->>'detail')::jsonb->'error'->>'message';
      exception when others then v_inner := null; end;
      v_reason := coalesce(v_inner, v_body->>'error', v_resp.error_msg, 'HTTP '||coalesce(v_status::text,'?'));
    exception when others then
      v_reason := coalesce(v_resp.error_msg, 'HTTP '||coalesce(v_status::text,'?'));
    end;
  end if;

  update public.ops_anthropic_canary
     set checked = true, ok = v_ok, status_code = v_status, failure_reason = v_reason
   where id = r.id;

  if v_ok then
    return jsonb_build_object('status','ok','status_code',v_status,'deal_id',r.deal_id);
  end if;

  -- ── AI is down ───────────────────────────────────────────────────────────
  -- In-app alert (stable fingerprint dedupes; bumps occurrences while open).
  perform public.report_system_alert(
    'anthropic-api',
    'AI features are DOWN: ' || coalesce(v_reason,'unknown') ||
      '. If this is a credit/billing error, add credits at console.anthropic.com -> Billing; everything resumes automatically.',
    'error',
    jsonb_build_object('status_code', v_status, 'reason', v_reason, 'canary_deal', r.deal_id, 'canary_id', r.id),
    'anthropic-api-down'
  );

  if p_notify then
    v_resend := public.get_resend_api_key();
    if v_resend is not null then
      v_html :=
        '<h2>&#9888; DCC AI is down</h2>' ||
        '<p>The daily Anthropic canary failed &mdash; every AI feature (Case Intelligence, AI SMS drafts, Lauren chat, morning sweep, call summaries) is paused.</p>' ||
        '<p><b>Reason:</b> ' || coalesce(v_reason,'unknown') || '<br><b>HTTP:</b> ' || coalesce(v_status::text,'?') || '</p>' ||
        '<p><b>Fix:</b> go to <a href="https://console.anthropic.com">console.anthropic.com</a> &rarr; Settings &rarr; Billing, add credits (and turn on auto-reload). Everything resumes automatically &mdash; no redeploy.</p>' ||
        '<p style="color:#888;font-size:12px">Canary deal ' || coalesce(r.deal_id,'?') || ' &middot; ' || now()::text || '</p>';
      perform net.http_post(
        url := 'https://api.resend.com/emails',
        headers := jsonb_build_object('Authorization','Bearer '||v_resend,'Content-Type','application/json'),
        body := jsonb_build_object(
          'from','FundLocators <hello@fundlocators.com>',
          'to', jsonb_build_array('nathan@fundlocators.com','justin@fundlocators.com'),
          'subject','⚠ DCC AI is DOWN — ' || left(coalesce(v_reason,'Anthropic API error'), 80),
          'html', v_html
        )
      );
      update public.ops_anthropic_canary set alerted_at = now() where id = r.id;
    end if;
  end if;

  return jsonb_build_object('status','down','status_code',v_status,'reason',v_reason,'notified',p_notify);
end;
$check$;

-- ── SCHEDULE: fire daily 13:00 UTC, check 13:15 UTC (tunable) ─────────────────
select cron.schedule('anthropic-canary-fire',  '0 13 * * *',  $$ select public.fire_anthropic_canary(); $$);
select cron.schedule('anthropic-canary-check', '15 13 * * *', $$ select public.check_anthropic_canary(); $$);
