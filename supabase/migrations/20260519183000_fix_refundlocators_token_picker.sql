-- 20260519183000_fix_refundlocators_token_picker.sql
-- Fix tg_sync_refundlocators_token so the deal's "primary" URL pill points
-- at the homeowner's link, not whichever family-contact link was inserted
-- most recently.
--
-- Original behavior (since 2026-04-25): the trigger unconditionally
-- overwrote deals.refundlocators_token with NEW.token. So if Castle later
-- created contact-specific tokens (e.g. "5Ui1HmZf-kendyl" for a relative),
-- the deal's top-of-card URL would flip to the most recently created one.
--
-- Repro 2026-05-19 — Heather Johnson deal (surplus-moiqruyvfmt9):
--   personalized_links rows for this deal:
--     5Ui1HmZf            → Heather Johnson  (homeowner, the right one)
--     5Ui1HmZf-noelle     → Noelle Hunt      (family contact)
--     5Ui1HmZf-kendyl     → Kendyl Hunt      (family contact)
--   deal.refundlocators_token was = '5Ui1HmZf-kendyl' (last-inserted)
--   UI displayed /s/5Ui1HmZf-kendyl at the top, which is wrong.
--
-- Fix: when the trigger fires, re-pick the best token by querying
-- personalized_links for ALL rows on the deal, preferring the "bare"
-- token (no dash suffix) which is Castle's homeowner-primary convention.
-- Fall back to the oldest-created row if no bare token exists.

CREATE OR REPLACE FUNCTION public.sync_refundlocators_token()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  best_token text;
BEGIN
  IF NEW.deal_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.deal_id IS NOT NULL
     AND OLD.deal_id = NEW.deal_id
     AND OLD.token = NEW.token THEN
    RETURN NEW;
  END IF;

  -- Pick the homeowner/primary link for this deal:
  --   priority 1: bare token (no dash) — Castle's homeowner convention
  --   priority 2: oldest created_at — usually still the homeowner
  SELECT token INTO best_token
  FROM personalized_links
  WHERE deal_id = NEW.deal_id
  ORDER BY
    (CASE WHEN token NOT LIKE '%-%' THEN 0 ELSE 1 END),
    created_at ASC NULLS LAST
  LIMIT 1;

  IF best_token IS NULL THEN
    RETURN NEW;
  END IF;

  UPDATE public.deals
     SET refundlocators_token = best_token
   WHERE id = NEW.deal_id::text
     AND (refundlocators_token IS NULL OR refundlocators_token != best_token);

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.sync_refundlocators_token() IS
  'Keeps deals.refundlocators_token = the bare/homeowner personalized_links token for the deal. Updated 2026-05-19 to stop overwriting with the most-recently-created contact-specific token (Heather Johnson bug — UI was showing /s/<token>-kendyl instead of /s/<token>).';

-- ── Backfill: for every deal with personalized_links, recompute the right token ──
-- One-shot pass. The trigger handles future inserts.
WITH best AS (
  SELECT DISTINCT ON (deal_id)
         deal_id,
         token
  FROM personalized_links
  WHERE deal_id IS NOT NULL
  ORDER BY deal_id,
           (CASE WHEN token NOT LIKE '%-%' THEN 0 ELSE 1 END),
           created_at ASC NULLS LAST
)
UPDATE deals d
   SET refundlocators_token = b.token
  FROM best b
 WHERE d.id = b.deal_id::text
   AND (d.refundlocators_token IS NULL OR d.refundlocators_token != b.token);

-- Verify (paste in a second tab after apply):
-- SELECT d.id, d.name, d.refundlocators_token,
--        (SELECT count(*) FROM personalized_links WHERE deal_id::text = d.id) AS link_count,
--        (SELECT string_agg(token, ', ' ORDER BY created_at)
--           FROM personalized_links WHERE deal_id::text = d.id) AS all_tokens
-- FROM deals d
-- WHERE d.id = 'surplus-moiqruyvfmt9';
--
-- Expect: refundlocators_token = '5Ui1HmZf' (bare token, the homeowner's).
