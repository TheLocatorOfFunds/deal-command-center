-- Atomic claim RPC for the court_pull_requests queue.
--
-- Castle's poller (in the refundlocators-pipeline repo) calls this to grab
-- the oldest queued request under FOR UPDATE SKIP LOCKED so multiple Castle
-- workers can run concurrently without double-claiming the same request.
-- Returns a row of NULLs when the queue is empty.
--
-- Originally applied from the Castle repo on 2026-04-22; mirrored here so the
-- DCC repo's migration history stays complete. Safe to re-apply: CREATE OR
-- REPLACE leaves behavior unchanged.
create or replace function public.claim_court_pull_request()
returns public.court_pull_requests
language plpgsql
security definer
set search_path = public
as $$
declare
    claimed public.court_pull_requests;
begin
    with candidate as (
        select id from public.court_pull_requests
        where status = 'queued'
        order by requested_at asc
        limit 1
        for update skip locked
    )
    update public.court_pull_requests cpr
    set status = 'processing', started_at = now()
    from candidate
    where cpr.id = candidate.id
    returning cpr.* into claimed;
    return claimed;
end;
$$;

revoke all on function public.claim_court_pull_request() from public, anon, authenticated;
grant execute on function public.claim_court_pull_request() to service_role;

comment on function public.claim_court_pull_request() is
  'Atomic claim of the next queued court pull request. Castle poller uses this to avoid double-claim under concurrent workers.';
