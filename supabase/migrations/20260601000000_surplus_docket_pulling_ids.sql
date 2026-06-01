-- Read-only helper for DocketCoverageStrip (Today view). Returns the DISTINCT
-- deal_ids of active-surplus deals that have >=1 docket event ("pulling live").
--
-- Replaces a client-side query that pulled ~8,190 docket_event rows just to
-- derive ~67 distinct ids (and before that scanned the whole docket_events
-- table via limit(20000), which would silently truncate once the table passed
-- 20k rows). The RPC computes the DISTINCT set server-side and returns ~67
-- ids — a ~99% payload cut on every Today-view load.
--
-- SECURITY INVOKER so it respects the caller's RLS on deals/docket_events
-- (operators can already read both tables directly). Perf pass, 2026-06-01.
CREATE OR REPLACE FUNCTION public.surplus_docket_pulling_ids()
RETURNS TABLE(deal_id text)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT DISTINCT de.deal_id
  FROM docket_events de
  JOIN deals d ON d.id = de.deal_id
  WHERE d.type = 'surplus'
    AND d.status NOT IN ('closed', 'dead', 'recovered')
    AND d.deleted_at IS NULL;
$$;

GRANT EXECUTE ON FUNCTION public.surplus_docket_pulling_ids() TO authenticated;
