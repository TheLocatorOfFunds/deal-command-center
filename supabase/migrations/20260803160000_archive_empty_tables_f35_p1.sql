-- F-35 audit Phase 1 (2026-08-03): archive-by-rename the two tables with
-- ZERO rows ever written and ZERO code references (verified src + EFs +
-- mobile + DB row counts). Rename, not drop — reversible per the 2026-06-22
-- pruning caution. The audit's other 5 candidates were DEFERRED after the
-- reader check found live consumers (va_work_queue ← lauren-internal;
-- message_groups/sms_templates/deal_library_pins/screen_recordings ← app UI).
alter table public.surplus_docket_events rename to zz_archived_surplus_docket_events;
alter table public.foreclosure_cases rename to zz_archived_foreclosure_cases;
