-- Capture v_call_tracker in version control (Director handoff Task 3, 2026-06-29).
-- The Main-Intel Director created this ad-hoc via SQL; this migration just makes
-- it reproducible (CREATE OR REPLACE is idempotent). Per-caller, per-day OUTBOUND
-- call stats; powers the admin Caller Scoreboard in CallHistoryView. 'booked' is
-- the KPI (appointment-setting). RLS inherits call_logs; UI panel is admin-gated.
create or replace view public.v_call_tracker as
select date(cl.created_at at time zone 'America/New_York') as call_date,
       cl.user_id, p.name as caller,
       count(*) as dials,
       count(*) filter (where cl.outcome = 'connected') as connected,
       count(*) filter (where cl.outcome = 'voicemail') as voicemail,
       count(*) filter (where cl.outcome = 'no_answer') as no_answer,
       count(*) filter (where cl.outcome in ('disconnected','wrong_number')) as bad_number,
       count(*) filter (where cl.outcome = 'booked') as booked,
       count(*) filter (where cl.outcome in ('not_interested','do_not_call')) as not_interested,
       round(100.0 * count(*) filter (where cl.outcome = 'connected') / nullif(count(*),0), 0) as connect_pct
from public.call_logs cl
left join public.profiles p on p.id = cl.user_id
where cl.direction = 'outbound'
group by 1, 2, 3;
