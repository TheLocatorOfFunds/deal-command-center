-- Nathan 2026-09-18: no daily 7am pulse. Cron removed; the morning-pulse
-- EF stays deployed for on-demand runs only (nothing schedules it).
select cron.unschedule('morning-pulse-sms');
