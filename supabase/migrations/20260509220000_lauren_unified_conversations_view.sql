-- DCC — Unified Lauren conversations view
--
-- Lauren's conversations live in three different tables today:
--
--   lauren_conversations  — website chat transcripts (refundlocators.com
--                            /api/lauren/log → one row per visitor session,
--                            transcript stored as jsonb on the row)
--   lauren_sessions       — Edge Function session state (lauren-chat for
--                            'homeowner' subtype + lauren-internal for
--                            'internal' subtype, messages stored as jsonb)
--   team_messages         — DCC team chat where Lauren participates
--                            (sender_kind='lauren'); per-MESSAGE rows
--                            grouped here by thread
--
-- This view collapses all three into one shape so the Comms Analytics
-- view + future audits can read "all Lauren activity" with one query.
-- Read-only; no schema changes to the source tables.
--
-- Per-conversation grain. For team chat, "conversation" = thread.

CREATE OR REPLACE VIEW public.v_lauren_all_conversations AS
-- ── Website chat (refundlocators.com /api/lauren/log) ───────────────
SELECT
  'website_chat'::text                                    AS source,
  id::text                                                AS source_id,
  'website_homeowner'::text                               AS surface,
  visitor_id                                              AS who,
  started_at,
  last_message_at                                         AS last_active_at,
  COALESCE(message_count, 0)                              AS message_count,
  COALESCE(submitted_claim, false)                        AS submitted_claim,
  page_origin                                             AS context_hint,
  token                                                   AS deal_token,
  NULL::text                                              AS deal_id,
  ip                                                      AS visitor_ip
FROM public.lauren_conversations

UNION ALL

-- ── Edge Function sessions (lauren-chat + lauren-internal) ──────────
-- session_type='homeowner' is the public lauren-chat path; 'internal'
-- is the owner/VA lauren-internal path. messages is a jsonb array, so
-- count by jsonb_array_length.
SELECT
  'edge_session'::text                                    AS source,
  id::text                                                AS source_id,
  CASE WHEN session_type = 'internal'
       THEN 'edge_internal'
       ELSE 'edge_homeowner' END                          AS surface,
  COALESCE(visitor_id, ghl_contact_id, deal_id, id::text) AS who,
  created_at                                              AS started_at,
  updated_at                                              AS last_active_at,
  COALESCE(jsonb_array_length(messages), 0)               AS message_count,
  false                                                   AS submitted_claim,
  session_type                                            AS context_hint,
  NULL::text                                              AS deal_token,
  deal_id,
  NULL::text                                              AS visitor_ip
FROM public.lauren_sessions

UNION ALL

-- ── DCC team chat threads where Lauren participated ────────────────
-- One row per thread. Aggregate Lauren-sent message_count + the thread's
-- created_at for started_at + max(message.created_at) for last_active.
SELECT
  'team_thread'::text                                     AS source,
  t.id::text                                              AS source_id,
  'team_thread'::text                                     AS surface,
  t.id::text                                              AS who,
  t.created_at                                            AS started_at,
  COALESCE(MAX(m.created_at), t.created_at)               AS last_active_at,
  COUNT(m.id)::int                                        AS message_count,
  false                                                   AS submitted_claim,
  COALESCE(t.title, t.thread_type)                        AS context_hint,
  NULL::text                                              AS deal_token,
  t.deal_id::text                                         AS deal_id,
  NULL::text                                              AS visitor_ip
FROM public.team_threads t
LEFT JOIN public.team_messages m
  ON m.thread_id = t.id
 AND m.sender_kind = 'lauren'
 AND m.deleted_at IS NULL
WHERE t.lauren_enabled = true
  AND t.archived_at IS NULL
GROUP BY t.id, t.created_at, t.title, t.thread_type, t.deal_id;

COMMENT ON VIEW public.v_lauren_all_conversations IS
  'Unified per-conversation grain across lauren_conversations (website), lauren_sessions (edge functions), and team_messages with sender_kind=lauren (team chat). Used by the Comms Analytics view in DCC.';

GRANT SELECT ON public.v_lauren_all_conversations TO authenticated;
