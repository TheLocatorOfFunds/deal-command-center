-- Surplus pipeline scaffolding (decision 2026-05-01).
-- Castle / Ohio Intel surplus-fund pipeline writes PDFs + docket events
-- into DCC's Supabase project. Distinct from active deals: separate
-- bucket (surplus-pdfs), separate table (surplus_docket_events).
--
-- Per-event PDFs land at surplus-pdfs/<castle_case_id>/<filename>. Castle
-- scrapers MUST upload PDFs DURING the scrape session — county portals
-- are session-protected so post-hoc fetch returns HTML, not the PDF.
-- The pdf_storage_path column on the event row points into the bucket.
--
-- See memory:
--   project_surplus_pdf_storage_decision.md  (why this lives in DCC)
--   project_docket_pdf_requirement.md         (why scrapers upload during scrape)

-- ─── Bucket ────────────────────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'surplus-pdfs',
  'surplus-pdfs',
  false,
  52428800,
  ARRAY['application/pdf', 'image/png', 'image/jpeg', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

-- Storage RLS — admin only. Service-role (Castle) bypasses RLS.
DROP POLICY IF EXISTS "admin all on surplus-pdfs" ON storage.objects;
CREATE POLICY "admin all on surplus-pdfs" ON storage.objects
  FOR ALL TO authenticated
  USING (bucket_id = 'surplus-pdfs' AND public.is_admin())
  WITH CHECK (bucket_id = 'surplus-pdfs' AND public.is_admin());

-- ─── Events table ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.surplus_docket_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  castle_case_id text NOT NULL,
  external_id text NOT NULL,
  case_number text,
  county text,
  court_system text,
  event_type text,
  event_date date,
  description text,
  document_url text,
  pdf_storage_path text,
  ocr_data jsonb,
  raw jsonb,
  litigation_stage text,
  deadline_metadata jsonb,
  attorney_appearance jsonb,
  detected_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  is_backfill boolean NOT NULL DEFAULT false,
  source text DEFAULT 'castle',
  CONSTRAINT surplus_docket_events_unique UNIQUE (castle_case_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_surplus_de_case_id      ON public.surplus_docket_events (castle_case_id);
CREATE INDEX IF NOT EXISTS idx_surplus_de_case_number  ON public.surplus_docket_events (case_number);
CREATE INDEX IF NOT EXISTS idx_surplus_de_event_date   ON public.surplus_docket_events (event_date DESC);
CREATE INDEX IF NOT EXISTS idx_surplus_de_county       ON public.surplus_docket_events (county);

ALTER TABLE public.surplus_docket_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin_all_surplus_docket_events" ON public.surplus_docket_events;
CREATE POLICY "admin_all_surplus_docket_events" ON public.surplus_docket_events
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

COMMENT ON TABLE  public.surplus_docket_events            IS 'Castle / Ohio Intel surplus-pipeline docket events. Distinct from public.docket_events which is active-deal-only. Per 2026-05-01 decision, surplus pipeline extends DCC infra rather than getting its own Supabase project. PDFs in surplus-pdfs bucket at <castle_case_id>/<filename>. Castle scrapers upload during scrape session (county portals are session-protected).';
COMMENT ON COLUMN public.surplus_docket_events.pdf_storage_path IS 'Path inside the surplus-pdfs bucket (e.g. <castle_case_id>/2026-05-01_motion-confirm-sale.pdf). NULL = no PDF on file. Required for all new events going forward per project_docket_pdf_requirement.md memory.';
COMMENT ON COLUMN public.surplus_docket_events.ocr_data         IS 'Claude Vision OCR output. Schema mirrors documents.extracted jsonb (document_type, confidence, fields, summary, notes).';
COMMENT ON COLUMN public.surplus_docket_events.castle_case_id   IS 'Castle / Ohio Intel case identifier. Format owned by Castle — could be UUID, internal slug, or external case_number. NOT a foreign key here; surplus_cases (if Castle adds one) would be the reference table.';
