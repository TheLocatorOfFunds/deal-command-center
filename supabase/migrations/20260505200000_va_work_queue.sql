-- DCC — Phase 3 of Lauren-on-top: va_work_queue
--
-- When the VA-audience Lauren receives an action request (e.g. "request
-- records on case X", "schedule outreach to Jane Doe", "flag this for
-- follow-up"), she does NOT execute it directly. Instead, the write tool
-- inserts a row into va_work_queue with status='pending', and an owner
-- (Nathan or Justin) reviews + approves before any actual side effect
-- happens.
--
-- Per Nathan's "fully loose, my VAs are my boys" stance: the gate is
-- the queue + owner review, not VA permissions. VAs can request anything;
-- nothing executes without owner approval.
--
-- Audit-loggish by design: every request is preserved (status, args,
-- reason VA gave, who reviewed, when, result). Future MAS-style auto-
-- approval rules can layer on top.

CREATE TABLE IF NOT EXISTS public.va_work_queue (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_by_id    uuid        NOT NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  requested_by_role  text        NOT NULL,                                 -- snapshot of profiles.role at request time
  tool_name          text        NOT NULL,                                 -- which "write tool" was invoked
  tool_args          jsonb       NOT NULL DEFAULT '{}'::jsonb,             -- the LLM's tool input
  reason             text,                                                  -- VA's stated reason (Lauren can prompt for one)
  conversation_id    uuid,                                                  -- lauren_sessions.id when available — for context
  status             text        NOT NULL DEFAULT 'pending'
                                  CHECK (status IN ('pending','approved','rejected','executed','cancelled','failed')),
  reviewed_by_id     uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at        timestamptz,
  reviewer_note      text,
  executed_at        timestamptz,
  execution_result   jsonb,
  execution_error    text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS va_work_queue_status_created_idx
  ON public.va_work_queue (status, created_at DESC);

CREATE INDEX IF NOT EXISTS va_work_queue_requested_by_idx
  ON public.va_work_queue (requested_by_id, created_at DESC);

CREATE INDEX IF NOT EXISTS va_work_queue_tool_name_idx
  ON public.va_work_queue (tool_name);

COMMENT ON TABLE public.va_work_queue IS
  'Phase 3 of Lauren-on-top: VA action requests pending owner review. Read more in the FundLocators-Vault decision dated 2026-05-05.';

-- Updated_at trigger so reviewer_note edits + status changes touch the column.
CREATE OR REPLACE FUNCTION public.va_work_queue_touch_updated_at()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tg_va_work_queue_touch_updated_at ON public.va_work_queue;
CREATE TRIGGER tg_va_work_queue_touch_updated_at
  BEFORE UPDATE ON public.va_work_queue
  FOR EACH ROW
  EXECUTE FUNCTION public.va_work_queue_touch_updated_at();

-- ── RLS ────────────────────────────────────────────────────────────
-- Service-role bypasses RLS so lauren-internal can insert + the review
-- UI can update. Authenticated VA-tier users can read their OWN rows
-- (so a VA-side dashboard could show "what I've requested"). Admins
-- (Nathan, Justin) can read + update everything.

ALTER TABLE public.va_work_queue ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS va_work_queue_va_self_read ON public.va_work_queue;
CREATE POLICY va_work_queue_va_self_read ON public.va_work_queue
  FOR SELECT
  TO authenticated
  USING (requested_by_id = auth.uid());

DROP POLICY IF EXISTS va_work_queue_admin_all ON public.va_work_queue;
CREATE POLICY va_work_queue_admin_all ON public.va_work_queue
  FOR ALL
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- ── Notification trigger ───────────────────────────────────────────
-- When a VA queues an action, fire pg_net.http_post to the existing
-- lauren-event-router so Nathan + Justin get an email. Reuses the same
-- vault secret (`lauren_event_secret`) that the Lauren conversation
-- triggers already use, plus a new event type 'va_queue_pending'.
--
-- Fail-quiet: if the secret isn't set or pg_net.http_post errors, the
-- INSERT still succeeds — we never block a VA's request because the
-- mail layer is down.

CREATE OR REPLACE FUNCTION public.notify_va_work_queued()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $$
DECLARE
  fn_secret  text;
  fn_url     text := 'https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/lauren-event-router';
BEGIN
  -- Only on freshly-queued items, not on subsequent reviewer updates.
  IF NEW.status <> 'pending' THEN
    RETURN NEW;
  END IF;

  BEGIN
    SELECT decrypted_secret INTO fn_secret
      FROM vault.decrypted_secrets
     WHERE name = 'lauren_event_secret'
     LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    fn_secret := NULL;
  END;

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
      'event', 'va_queue_pending',
      'queue_id', NEW.id,
      'tool_name', NEW.tool_name,
      'requested_by_id', NEW.requested_by_id
    )::jsonb
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tg_notify_va_work_queued ON public.va_work_queue;
CREATE TRIGGER tg_notify_va_work_queued
  AFTER INSERT
  ON public.va_work_queue
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_va_work_queued();

GRANT SELECT ON public.va_work_queue TO authenticated;
