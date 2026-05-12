-- 2026-05-12 — Lock down lauren-team-respond with a shared secret.
--
-- Found during Tier 1C of the Kemper security deep dive:
-- lauren-team-respond was deployed with verify_jwt=false but had NO
-- custom auth check. Anyone with the URL could POST and trigger Lauren
-- to respond, costing Anthropic API tokens + writing into team_messages
-- threads with attacker-controlled context.
--
-- Fix:
--   1. Generate a random secret, store in vault.decrypted_secrets
--      under name 'lauren_team_respond_secret'.
--   2. Update tg_lauren_team_respond trigger to fetch + pass it as
--      X-Lauren-Team-Respond-Secret header. Mirrors the pattern
--      lauren-event-router already uses (lauren_event_secret).
--   3. The Edge Function (deployed separately) validates the header
--      OR validates an admin/va JWT in Authorization (frontend
--      deal-card surface).
--
-- This migration is idempotent — re-running it won't change the
-- existing secret value if already present, but it WILL update the
-- trigger function. Set the actual vault secret value manually via
-- the dashboard if `vault.decrypted_secrets` doesn't already have a
-- row for 'lauren_team_respond_secret'.

-- ── 1. Update the trigger to fetch + pass the secret ──────────────
create or replace function public.tg_lauren_team_respond()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_thread record;
  v_secret text;
  v_url text := 'https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/lauren-team-respond';
begin
  if NEW.sender_kind = 'lauren' then return NEW; end if;
  if NEW.deleted_at is not null then return NEW; end if;

  select * into v_thread from public.team_threads where id = NEW.thread_id;
  if v_thread is null or v_thread.lauren_enabled is not true then
    return NEW;
  end if;

  -- Hub mode: Lauren always responds in lauren_dm. In rooms and other
  -- thread types, she only fires when @-mentioned.
  if v_thread.thread_type <> 'lauren_dm'
     and not public.lauren_is_mentioned(NEW.body)
  then
    return NEW;
  end if;

  -- Fetch the shared secret from vault. Fail-quiet: if the secret
  -- isn't set, do nothing rather than break the chat flow. Manual
  -- setup step: insert into vault.secrets via dashboard.
  begin
    select decrypted_secret into v_secret
    from vault.decrypted_secrets
    where name = 'lauren_team_respond_secret'
    limit 1;
  exception when others then
    v_secret := null;
  end;

  if v_secret is null then
    raise notice 'tg_lauren_team_respond: lauren_team_respond_secret not set in vault — skipping';
    return NEW;
  end if;

  begin
    perform net.http_post(
      url := v_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'X-Lauren-Team-Respond-Secret', v_secret
      ),
      body := jsonb_build_object('thread_id', NEW.thread_id, 'message_id', NEW.id),
      timeout_milliseconds := 30000
    );
  exception when others then
    raise notice 'lauren-team-respond fire-and-forget failed: %', sqlerrm;
  end;

  return NEW;
end;
$$;

-- ── 2. (Manual step) Set the vault secret ─────────────────────────
-- Run this via the dashboard SQL editor with a fresh random value, OR
-- via the Supabase Dashboard → Settings → Vault:
--
--   select vault.create_secret(
--     -- replace with: openssl rand -hex 32  output, kept somewhere safe
--     'REPLACE-WITH-RANDOM-64-CHAR-HEX',
--     'lauren_team_respond_secret',
--     'Shared secret between tg_lauren_team_respond trigger and the lauren-team-respond Edge Function. Created 2026-05-12 as part of the Kemper security hardening.'
--   );
--
-- THEN set the SAME value in the Edge Function's secrets:
--   Dashboard → Edge Functions → Secrets → add LAUREN_TEAM_RESPOND_SECRET = <same value>
