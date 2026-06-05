-- Who marked a lead ready (Nathan 2026-06-05: "we need to know who marked a
-- lead ready — Anam or Eric — so if we have questions we go back to that
-- person"). The activity feed already logs WHO (user_id) for the full audit
-- trail; these denormalized columns power an at-a-glance "Ready · <name>" badge
-- on the card/Overview without a per-card profiles join, and avoid stuffing it
-- into the meta jsonb (which would collide with the Case Details edit buffer +
-- intel-main sync). Closes #257.
ALTER TABLE public.deals ADD COLUMN IF NOT EXISTS readied_by text;
ALTER TABLE public.deals ADD COLUMN IF NOT EXISTS readied_by_at timestamptz;

-- Backfill from the existing "Marked ready for outreach" activity rows so every
-- currently-ready lead shows attribution immediately (not just future ones).
-- (Leads readied before attribution logging started 2026-05-29 have no activity
-- row to backfill from and stay NULL — the badge just won't show for those.)
UPDATE public.deals d
SET readied_by = sub.name, readied_by_at = sub.created_at
FROM (
  SELECT DISTINCT ON (a.deal_id) a.deal_id, p.name, a.created_at
  FROM public.activity a
  JOIN public.profiles p ON p.id = a.user_id
  WHERE a.action ILIKE '%marked ready for outreach%'
  ORDER BY a.deal_id, a.created_at DESC
) sub
WHERE d.id = sub.deal_id
  AND d.prepped_at IS NOT NULL
  AND d.readied_by IS NULL;
