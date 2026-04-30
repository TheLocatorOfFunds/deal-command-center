-- ─────────────────────────────────────────────────────────────────
-- 20260430230000_lauren_rate_limit
--
-- Per-visitor and per-IP rate limiting for the public lauren-chat
-- Edge Function. Keeps an attacker from running 10,000 prompt-injection
-- variations against you in 5 minutes (cost burn + telemetry noise).
--
-- The hardened lauren-chat reads from this table at the top of every
-- request. If the visitor or IP is over its hourly limit, return the
-- canned refusal and don't call Anthropic.
--
-- Buckets are per-hour. We let rows accumulate and prune older than
-- 7 days via a daily cleanup.
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.lauren_rate_limit (
  scope        text        NOT NULL,           -- 'visitor' | 'ip'
  key          text        NOT NULL,           -- visitor_id or ip
  hour_bucket  timestamptz NOT NULL,           -- date_trunc('hour', now())
  count        integer     NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, key, hour_bucket)
);

CREATE INDEX IF NOT EXISTS lauren_rate_limit_bucket_idx
  ON public.lauren_rate_limit (hour_bucket DESC);

COMMENT ON TABLE public.lauren_rate_limit IS
  'Per-visitor and per-IP hourly counters for lauren-chat. Read+upserted by the hardened Edge Function before invoking Anthropic.';

-- RLS: lock down to service_role only.
ALTER TABLE public.lauren_rate_limit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lauren_rate_limit_service_role_all ON public.lauren_rate_limit;
CREATE POLICY lauren_rate_limit_service_role_all
  ON public.lauren_rate_limit
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ── Convenience function: bump + return new count ───────────────────
-- Call from the Edge Function. Returns the count AFTER increment.
-- p_scope: 'visitor' | 'ip'
-- p_key:   the visitor_id or ip address
-- Returns: int — new count for this hour bucket
CREATE OR REPLACE FUNCTION public.lauren_rate_limit_bump(p_scope text, p_key text)
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $$
DECLARE
  bucket timestamptz := date_trunc('hour', now());
  new_count integer;
BEGIN
  INSERT INTO public.lauren_rate_limit (scope, key, hour_bucket, count)
    VALUES (p_scope, p_key, bucket, 1)
  ON CONFLICT (scope, key, hour_bucket)
    DO UPDATE SET count = public.lauren_rate_limit.count + 1
  RETURNING count INTO new_count;
  RETURN new_count;
END;
$$;

COMMENT ON FUNCTION public.lauren_rate_limit_bump(text, text) IS
  'Atomically increments and returns the count for (scope, key) in the current hour. Used by lauren-chat before LLM call.';

GRANT EXECUTE ON FUNCTION public.lauren_rate_limit_bump(text, text) TO service_role;

-- ── Daily cleanup: delete buckets older than 7 days ────────────────
-- Schedule via pg_cron alongside the other dailies.
SELECT cron.schedule(
  'lauren-rate-limit-cleanup',
  '0 6 * * *',
  $$ DELETE FROM public.lauren_rate_limit WHERE hour_bucket < now() - interval '7 days'; $$
);
