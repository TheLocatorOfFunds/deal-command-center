-- Phase 2: Lauren joins Team Chat.
--
-- Architecture: pg trigger on team_messages INSERT detects @lauren mentions,
-- fires (asynchronously, via pg_net) the lauren-team-respond Edge Function.
-- The EF reads the thread context, calls Claude, inserts Lauren's reply
-- back as a team_messages row with sender_kind='lauren'. Both N + J see
-- her response stream in via realtime.
--
-- Mention pattern: case-insensitive @lauren, lauren, (with comma), or "L:"
-- at message start. Quiet by default — Lauren only speaks when summoned.

-- Enable Lauren on the default Ops thread. Other threads default disabled
-- so a per-deal thread or DM doesn't auto-summon her unless we want her.
update public.team_threads set lauren_enabled = true where title = 'Ops';

-- Helper: given a message body, decide if Lauren is mentioned. Centralized
-- so the trigger and the UI can use the same regex (avoid drift).
create or replace function public.lauren_is_mentioned(p_body text)
returns boolean
language sql
immutable
as $$
  select coalesce(p_body, '') ~* '(@lauren\b|^\s*lauren[,:]|^\s*L:)';
$$;

-- The trigger function. Fires after each team_messages INSERT. Checks
-- conditions, then fire-and-forgets a POST to the EF. Wrapped in a
-- BEGIN/EXCEPTION block so a Lauren outage never blocks the message
-- insert itself — chat keeps working even if Lauren is down.
create or replace function public.tg_lauren_team_respond()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_thread record;
  v_url text := 'https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/lauren-team-respond';
begin
  -- Don't react to Lauren's own messages (would loop)
  if NEW.sender_kind = 'lauren' then return NEW; end if;
  -- Don't react to soft-deleted messages
  if NEW.deleted_at is not null then return NEW; end if;
  -- Skip if thread doesn't have Lauren enabled
  select * into v_thread from public.team_threads where id = NEW.thread_id;
  if v_thread is null or v_thread.lauren_enabled is not true then return NEW; end if;
  -- Skip if not mentioned
  if not public.lauren_is_mentioned(NEW.body) then return NEW; end if;

  begin
    perform net.http_post(
      url := v_url,
      headers := jsonb_build_object('Content-Type','application/json'),
      body := jsonb_build_object('thread_id', NEW.thread_id, 'message_id', NEW.id),
      timeout_milliseconds := 30000
    );
  exception when others then
    -- Log the failure as a system activity row but don't block the insert.
    -- Lauren just won't respond on this message; user can re-summon her.
    raise notice 'lauren-team-respond fire-and-forget failed: %', sqlerrm;
  end;
  return NEW;
end;
$$;

drop trigger if exists trg_lauren_team_respond on public.team_messages;
create trigger trg_lauren_team_respond
  after insert on public.team_messages
  for each row execute function public.tg_lauren_team_respond();

-- Read-only RPCs Lauren can call from inside the EF (via service role).
-- Kept tight — read scope only, never write. If Lauren needs to do
-- something, she asks Nathan to confirm in chat.

-- Fuzzy deal lookup by name or address fragment. Returns up to 5 matches.
create or replace function public.lauren_lookup_deal(p_needle text)
returns table(deal_id text, name text, type text, status text, address text, county text, owner text)
language sql
security definer
set search_path = public
as $$
  select d.id, d.name, d.type, d.status, d.address, d.meta->>'county',
         (select p.name from public.profiles p where p.id = d.owner_id)
  from public.deals d
  where (d.name ilike '%' || p_needle || '%'
      or d.address ilike '%' || p_needle || '%'
      or d.id ilike '%' || p_needle || '%')
  order by d.created_at desc
  limit 5;
$$;
grant execute on function public.lauren_lookup_deal(text) to authenticated, service_role;

-- Recent activity timeline for a deal.
create or replace function public.lauren_recent_activity(p_deal_id text, p_limit int default 10)
returns table(action text, author text, when_at timestamptz)
language sql
security definer
set search_path = public
as $$
  select a.action, coalesce(p.name, 'Team'), a.created_at
  from public.activity a
  left join public.profiles p on p.id = a.user_id
  where a.deal_id = p_deal_id
  order by a.created_at desc
  limit p_limit;
$$;
grant execute on function public.lauren_recent_activity(text, int) to authenticated, service_role;

-- Upcoming court events / deadlines / sheriff sales across all deals.
create or replace function public.lauren_upcoming_events(p_window_days int default 14)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'hearings', coalesce((
      select jsonb_agg(row_to_json(h))
      from (
        select deal_id, event_type, event_date, litigation_stage
        from public.docket_events
        where event_date is not null
          and event_date >= current_date
          and event_date <= current_date + p_window_days
        order by event_date asc
        limit 20
      ) h
    ), '[]'::jsonb),
    'sheriff_sales', coalesce((
      select jsonb_agg(row_to_json(s))
      from (
        select case_number, property_address, sale_date, county
        from public.foreclosure_cases
        where sale_date is not null
          and sale_date >= current_date
          and sale_date <= current_date + p_window_days
        order by sale_date asc
        limit 20
      ) s
    ), '[]'::jsonb)
  );
$$;
grant execute on function public.lauren_upcoming_events(int) to authenticated, service_role;

-- Find contacts by name, company, or kind.
create or replace function public.lauren_search_contacts(p_needle text)
returns table(name text, company text, kind text, phone text, email text)
language sql
security definer
set search_path = public
as $$
  select c.name, c.company, c.kind, c.phone, c.email
  from public.contacts c
  where c.name    ilike '%' || p_needle || '%'
     or c.company ilike '%' || p_needle || '%'
     or c.kind    ilike '%' || p_needle || '%'
  order by c.created_at desc
  limit 10;
$$;
grant execute on function public.lauren_search_contacts(text) to authenticated, service_role;
