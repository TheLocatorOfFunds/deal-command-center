-- PERF / INCIDENT (Nathan 2026-06-24): Chat sat on "Loading…" and the whole app
-- dragged because the database was saturated. Root cause: loadRecentActivity()
-- (the Team Activity feed) runs `select ... from activity order by created_at
-- desc limit 25` on mount AND on every activity realtime event — and the activity
-- table (~177k rows / 42MB) had NO index on created_at. So every team action made
-- every open browser re-sort 177k rows. Stacked on the review-view + worklist load,
-- it choked the connection pool and chat couldn't get a connection.
-- Adding this index makes that feed an instant index scan. Applied to prod via
-- execute_sql (apply_migration timed out under the saturation).
create index if not exists idx_activity_created_at on public.activity (created_at desc);
