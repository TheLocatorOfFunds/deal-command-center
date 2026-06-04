-- Research-agent blocker B-1 (open since 2026-05): markPrepped's Day-0
-- auto-queue was CLIENT-SIDE JS, so a service-role write of prepped_at (the
-- research agent finishing a lead) set the timestamp and fired NOTHING — found
-- phone numbers dead-ended, no Day-0 draft ever surfaced. This moves the
-- auto-queue into the DB so it fires for ANY prepped_at NULL->non-NULL
-- transition: the research agent, the Today "Mark Prepped" button (its client
-- insert now harmlessly dedup's against this via its own existing-row guard),
-- AND the lead-card "Mark Ready" toggle (which previously set prepped_at but
-- never queued — an inconsistency this fixes).
--
-- SAFE BY DESIGN:
--   * Day-0 (cadence_day=0) is HUMAN-GATED — dispatch-cadence-message skips it
--     ('cadence_day=0 is human-gated'). This only creates a DRAFT a human
--     approves; it can never auto-text a homeowner.
--   * Gated to tier A/B, active status, NOT deceased (family-pivot outreach is
--     sensitive — a human queues that), a textable non-DNC phone, and no
--     existing active outreach_queue row (dedupe).
--   * Forward-only (fires on the transition, never backfills already-prepped
--     deals) and exception-safe (never blocks the prep write).
--   * Folds in the "phone is on a linked contact but not in meta" case (~35
--     leads) via the contact-phone fallback.
--
-- Verified 2026-06-04 with a rolled-back synthetic test matrix: A+phone -> 1,
-- A+contact-phone -> 1, C-tier -> 0, deceased -> 0, no-phone -> 0, existing
-- row -> stays 1 (dedup).
--
-- ⚠ Justin: this writes into outreach_queue (your SMS pipeline) on prep. It
-- mirrors the markPrepped client auto-queue that already existed; the send path
-- is unchanged and Day-0 stays human-gated by your dispatcher.
CREATE OR REPLACE FUNCTION public.tg_autoqueue_day0_on_prep()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone text;
  v_deceased boolean;
BEGIN
  -- Gate: tier A/B, active status only.
  IF NEW.lead_tier IS DISTINCT FROM 'A' AND NEW.lead_tier IS DISTINCT FROM 'B' THEN
    RETURN NEW;
  END IF;
  IF NEW.status IN ('closed','dead','recovered') THEN
    RETURN NEW;
  END IF;

  -- Never auto-queue a deceased homeowner — mirror isDeceased() (death_signal
  -- column OR meta.deceased true, with meta.deceased='false' as explicit override).
  v_deceased := COALESCE(NEW.death_signal, false)
             OR (NEW.meta->>'deceased') IN ('true','True','t','1');
  IF (NEW.meta->>'deceased') = 'false' THEN v_deceased := false; END IF;
  IF v_deceased THEN
    RETURN NEW;
  END IF;

  -- Resolve a textable phone: meta first (mirrors dealMetaPhone + the agent's
  -- ownerPhone), else fall back to a linked NON-DNC contact's phone.
  v_phone := COALESCE(
    NULLIF(trim(NEW.meta->>'homeownerPhone'),''),
    NULLIF(trim(NEW.meta->>'phone'),''),
    NULLIF(trim(NEW.meta->>'contactPhone'),''),
    NULLIF(trim(NEW.meta->>'homeowner_phone'),''),
    NULLIF(trim(NEW.meta->>'ownerPhone'),'')
  );

  IF v_phone IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM contacts WHERE phone = v_phone AND do_not_text = true) THEN
      RETURN NEW;  -- meta phone belongs to a do-not-text contact
    END IF;
  ELSE
    SELECT NULLIF(trim(c.phone),'')
      INTO v_phone
      FROM contact_deals cd
      JOIN contacts c ON c.id = cd.contact_id
     WHERE cd.deal_id = NEW.id
       AND NULLIF(trim(c.phone),'') IS NOT NULL
       AND COALESCE(c.do_not_text, false) = false
     ORDER BY (cd.relationship = 'homeowner') DESC
     LIMIT 1;
  END IF;

  IF v_phone IS NULL THEN
    RETURN NEW;  -- nobody to text yet — research agent / human still needs a number
  END IF;

  -- Dedupe against any active queue row.
  IF EXISTS (
    SELECT 1 FROM outreach_queue
     WHERE deal_id = NEW.id
       AND status NOT IN ('skipped','cancelled','failed','sent')
  ) THEN
    RETURN NEW;
  END IF;

  INSERT INTO outreach_queue (deal_id, contact_phone, cadence_day, status, scheduled_for)
  VALUES (NEW.id, v_phone, 0, 'queued', now());

  INSERT INTO activity (deal_id, user_id, action, visibility)
  VALUES (NEW.id, NULL, '📤 Auto-queued Day-0 outreach draft (prep complete)', ARRAY['team']);

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;  -- auto-queue is best-effort; never block the prep write
END;
$$;

DROP TRIGGER IF EXISTS tg_autoqueue_day0_on_prep ON public.deals;
CREATE TRIGGER tg_autoqueue_day0_on_prep
  AFTER UPDATE OF prepped_at ON public.deals
  FOR EACH ROW
  WHEN (OLD.prepped_at IS NULL AND NEW.prepped_at IS NOT NULL)
  EXECUTE FUNCTION public.tg_autoqueue_day0_on_prep();
