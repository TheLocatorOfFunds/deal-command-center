-- Fix: CourtPullButton showed "Pull in progress… Queued · 10m ago"
-- forever, even when Castle had already marked the row failed.
--
-- Cause: court_pull_requests was never added to supabase_realtime, so
-- the JSX's postgres_changes subscription never received UPDATE events
-- after the initial load. Status appeared stuck because the client
-- only ever saw the row at insert time.
--
-- Idempotent — won't error if already in the publication.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'court_pull_requests'
  ) then
    alter publication supabase_realtime add table public.court_pull_requests;
  end if;
end $$;
