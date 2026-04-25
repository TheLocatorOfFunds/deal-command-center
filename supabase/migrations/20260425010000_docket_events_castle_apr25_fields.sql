-- Capture Castle's Apr 25 sprint additions on docket_events.
--
-- Castle now emits three new optional fields per docket event:
--   - litigation_stage: text  (filed | service | hearing_scheduled | hearing_held |
--                              order_entered | distribution_ordered | distribution_paid | closed)
--   - deadline_metadata: jsonb  (e.g. {appeal_window_days: 30, deadline_notes: "..."})
--   - attorney_appearance: jsonb  (e.g. {attorney_name, firm_name, role, bar_number, raw_excerpt})
--                                 only populated when event_type = 'attorney_appearance'
--
-- All three are additive + nullable. Old payloads still write cleanly.
-- The webhook handler in supabase/functions/docket-webhook reads them off
-- the incoming JSON and writes them through unchanged.
--
-- Castle commit references: bc50da8 (K.1 stage), eb2409b (K.3 deadlines),
-- 51454e6 (H.b attorney_appearance) on castle-v2/main.

alter table public.docket_events
  add column if not exists litigation_stage text,
  add column if not exists deadline_metadata jsonb,
  add column if not exists attorney_appearance jsonb;

alter table public.docket_events_unmatched
  add column if not exists litigation_stage text,
  add column if not exists deadline_metadata jsonb,
  add column if not exists attorney_appearance jsonb;

-- Indexes that pay for themselves once UI surfaces these:
-- 1. Deadline-soonest sort — only events with a known statutory window
create index if not exists idx_docket_events_deadline_soonest
  on public.docket_events ((event_date + (deadline_metadata->>'appeal_window_days')::int))
  where deadline_metadata is not null
    and deadline_metadata ? 'appeal_window_days'
    and is_backfill = false;

-- 2. Attorney-appearance lookups for the Partner Attorney directory
create index if not exists idx_docket_events_attorney_lookup
  on public.docket_events ((attorney_appearance->>'attorney_name'), (attorney_appearance->>'firm_name'))
  where attorney_appearance is not null;

-- 3. Litigation-stage filtering for case-timeline views
create index if not exists idx_docket_events_litigation_stage
  on public.docket_events (deal_id, litigation_stage, event_date desc)
  where litigation_stage is not null;

comment on column public.docket_events.litigation_stage is
  'Lifecycle bucket (Castle K.1): filed | service | hearing_scheduled | hearing_held | order_entered | distribution_ordered | distribution_paid | closed. Null on docket_updated and other non-classifiable events.';

comment on column public.docket_events.deadline_metadata is
  'Statutory countdown info (Castle K.3, Ohio-only V1). Keys: appeal_window_days, response_due_in_days, redemption_period_days, deadline_notes (citation).';

comment on column public.docket_events.attorney_appearance is
  'Attorney filing info (Castle H.b). Populated when event_type=attorney_appearance. Keys: attorney_name, firm_name, role, bar_number, raw_excerpt.';
