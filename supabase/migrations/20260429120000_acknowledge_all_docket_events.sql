-- Bulk-acknowledge every unacknowledged docket_events row in one statement.
--
-- Per Nathan 2026-04-29: the docket badge was at 1811 unacked events and
-- the existing "Acknowledge all" button only worked on the 100 events
-- loaded in the modal (page 1). Clicking it 19 times to clear everything
-- is silly. This RPC clears the whole queue server-side, returns the count.
--
-- Admin-only (the existing acknowledge_docket_event RPC is admin-only too).
-- VAs don't get this — they shouldn't be able to mass-clear the docket
-- without an admin signing off.

create or replace function public.acknowledge_all_docket_events()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  if not public.is_admin() then
    raise exception 'admin only';
  end if;

  update public.docket_events
     set acknowledged_at = now(),
         acknowledged_by = auth.uid()
   where acknowledged_at is null;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

grant execute on function public.acknowledge_all_docket_events() to authenticated;
