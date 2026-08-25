-- Fix: bad_phone_numbers' real columns are first_marked_deal_id /
-- occurrence_count / last_marked_at (not deal_id/occurrences/last_seen_at).
-- Reuse the existing mark_bad_number RPC instead of hand-rolling the upsert —
-- one code path for number quarantine, same as the disposition flow.
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
  perform public.mark_bad_number(v_phone, 'wrong_person', v_deal, null, null);
  insert into activity (deal_id, user_id, action, visibility)
  values (v_deal, null, '🙅 Wrong-person tap on the money page — number quarantined (no more texts to it); GHL DND syncs within 15 min', array['team']);
  return new;
end $$;
