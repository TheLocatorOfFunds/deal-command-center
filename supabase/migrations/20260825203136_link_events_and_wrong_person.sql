-- #340: funnel events from personalized pages (/api/s/event on the site
-- already POSTs these; the table just didn't exist) + wrong_person acting.
create table if not exists public.link_events (
  id bigint generated always as identity primary key,
  token text references public.personalized_links(token),
  event text not null,
  meta jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_link_events_token_time on public.link_events(token, created_at);
create index if not exists idx_link_events_event_time on public.link_events(event, created_at desc);
alter table public.link_events enable row level security;

-- wrong_person → the texted number is NOT the claimant's: quarantine the
-- NUMBER (not the person) via bad_phone_numbers, which may_contact() and the
-- dialer already honor; ghl-sync's OUT pass picks it up for GHL DND within
-- 15 minutes. One brain, no second path.
create or replace function public.tg_link_event_wrong_person()
returns trigger language plpgsql security definer
set search_path = public, pg_catalog as $$
declare
  v_deal text;
  v_phone text;
begin
  if new.event <> 'wrong_person' then return new; end if;
  select pl.deal_id into v_deal from personalized_links pl where pl.token = new.token limit 1;
  if v_deal is null then return new; end if;
  select split_part(coalesce(d.meta->>'homeownerPhone', d.meta->>'phone', ''), ',', 1)
    into v_phone from deals d where d.id = v_deal;
  if coalesce(v_phone, '') = '' then return new; end if;
  insert into bad_phone_numbers (phone, reason, deal_id, occurrences, last_seen_at)
  values (right(regexp_replace(v_phone, '\D', '', 'g'), 10), 'wrong_person', v_deal, 1, now())
  on conflict (phone) do update
    set reason = 'wrong_person', occurrences = bad_phone_numbers.occurrences + 1, last_seen_at = now();
  insert into activity (deal_id, user_id, action, visibility)
  values (v_deal, null, '🙅 Wrong-person tap on the money page — number quarantined (no more texts to it); GHL DND syncs within 15 min', array['team']);
  return new;
end $$;

drop trigger if exists trg_link_event_wrong_person on public.link_events;
create trigger trg_link_event_wrong_person
after insert on public.link_events
for each row execute function public.tg_link_event_wrong_person();
