-- ─────────────────────────────────────────────────────────────────
-- 20260430220000_lauren_event_router
--
-- Creates the alert path for Lauren conversation activity:
--   1. lauren_alerts table (history + dedupe substrate + future DCC sidebar)
--   2. lauren_event_dispatch() trigger function — fires pg_net.http_post
--      to the lauren-event-router Edge Function
--   3. Three triggers on lauren_conversations:
--      - INSERT (new conversation started)
--      - UPDATE when submitted_claim flips false → true
--      - UPDATE when message_count increases
--
-- The Edge Function decides which of these warrant an actual email.
--
-- Required Vault secret (set BEFORE running this migration):
--   INSERT INTO vault.secrets (name, secret)
--     VALUES ('lauren_event_secret', '<random 32+ char string>');
-- ─────────────────────────────────────────────────────────────────

-- ── 1. lauren_alerts table ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.lauren_alerts (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid        REFERENCES public.lauren_conversations(id) ON DELETE CASCADE,
  visitor_id      text        NOT NULL,
  signal_type     text        NOT NULL,
  sent_at         timestamptz NOT NULL DEFAULT now(),
  meta            jsonb       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS lauren_alerts_visitor_signal_idx
  ON public.lauren_alerts (visitor_id, signal_type, sent_at DESC);

CREATE INDEX IF NOT EXISTS lauren_alerts_sent_at_idx
  ON public.lauren_alerts (sent_at DESC);

CREATE INDEX IF NOT EXISTS lauren_alerts_conversation_idx
  ON public.lauren_alerts (conversation_id);

COMMENT ON TABLE public.lauren_alerts IS
  'History of Lauren-conversation alerts emitted by lauren-event-router. Used for dedupe and a future DCC sidebar.';

-- RLS: lock down. Service role + admins only.
ALTER TABLE public.lauren_alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lauren_alerts_service_role_all ON public.lauren_alerts;
CREATE POLICY lauren_alerts_service_role_all
  ON public.lauren_alerts
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ── 2. Trigger dispatch function ────────────────────────────────────

CREATE OR REPLACE FUNCTION public.lauren_event_dispatch()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $$
DECLARE
  fn_secret text;
  fn_url    text := 'https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/lauren-event-router';
  evt       text;
BEGIN
  -- Identify which event we're dispatching based on op + diff.
  IF TG_OP = 'INSERT' THEN
    evt := 'started';
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.submitted_claim IS TRUE
       AND (OLD.submitted_claim IS DISTINCT FROM NEW.submitted_claim) THEN
      evt := 'submitted';
    ELSIF NEW.message_count IS DISTINCT FROM OLD.message_count
          AND NEW.message_count > COALESCE(OLD.message_count, 0) THEN
      evt := 'message_added';
    ELSE
      RETURN NEW;
    END IF;
  ELSE
    RETURN NEW;
  END IF;

  BEGIN
    SELECT decrypted_secret
      INTO fn_secret
      FROM vault.decrypted_secrets
     WHERE name = 'lauren_event_secret'
     LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    fn_secret := NULL;
  END;

  -- Fail-quiet: if the secret isn't set, do nothing. Better to lose
  -- a notification than to break the website's chat-log path.
  IF fn_secret IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM net.http_post(
    url     := fn_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Lauren-Event-Secret', fn_secret
    ),
    body    := jsonb_build_object(
      'event', evt,
      'conversation_id', NEW.id
    )::jsonb
  );

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.lauren_event_dispatch() IS
  'Fires pg_net.http_post to lauren-event-router on lauren_conversations activity. Auth via vault secret lauren_event_secret.';

-- ── 3. Triggers on lauren_conversations ────────────────────────────

-- Drop any prior versions for idempotency.
DROP TRIGGER IF EXISTS tg_lauren_conversation_inserted     ON public.lauren_conversations;
DROP TRIGGER IF EXISTS tg_lauren_conversation_submitted    ON public.lauren_conversations;
DROP TRIGGER IF EXISTS tg_lauren_conversation_message_added ON public.lauren_conversations;

CREATE TRIGGER tg_lauren_conversation_inserted
  AFTER INSERT
  ON public.lauren_conversations
  FOR EACH ROW
  EXECUTE FUNCTION public.lauren_event_dispatch();

CREATE TRIGGER tg_lauren_conversation_submitted
  AFTER UPDATE OF submitted_claim
  ON public.lauren_conversations
  FOR EACH ROW
  WHEN (NEW.submitted_claim = TRUE AND OLD.submitted_claim IS DISTINCT FROM NEW.submitted_claim)
  EXECUTE FUNCTION public.lauren_event_dispatch();

CREATE TRIGGER tg_lauren_conversation_message_added
  AFTER UPDATE OF message_count
  ON public.lauren_conversations
  FOR EACH ROW
  WHEN (NEW.message_count IS DISTINCT FROM OLD.message_count
        AND NEW.message_count > COALESCE(OLD.message_count, 0))
  EXECUTE FUNCTION public.lauren_event_dispatch();

-- ── 4. Sanity grants ────────────────────────────────────────────────

GRANT SELECT ON public.lauren_alerts TO authenticated;
-- The Edge Function uses service_role; service_role already has full
-- access via the policy above.
