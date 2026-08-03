-- F-35 Phase 3 (2026-08-03): wire bad_phone_numbers for real.
-- The table existed with 0 rows while 27.6% of dials hit dead lines. Now:
-- • unique(phone) for upserts (bare 10-digit normalized)
-- • mark_bad_number() RPC — the disposition flow calls it on disconnected/
--   wrong_number outcomes; occurrence_count bumps on repeats
-- • backfilled 203 distinct dead/wrong numbers from historical call
--   dispositions, provenance in notes
-- The power dialer excludes these numbers from its queue.
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid='public.bad_phone_numbers'::regclass and contype in ('p','u')) then
    alter table public.bad_phone_numbers add constraint bad_phone_numbers_phone_key unique (phone);
  end if;
end $$;
create or replace function public.mark_bad_number(p_phone text, p_reason text, p_deal_id text default null, p_contact_id uuid default null, p_contact_name text default null)
returns void language plpgsql security definer set search_path to 'public' as $fn$
declare bare text := right(regexp_replace(coalesce(p_phone,''), '\D', '', 'g'), 10);
begin
  if length(bare) < 7 then return; end if;
  insert into bad_phone_numbers (phone, reason, first_marked_at, first_marked_by, first_marked_deal_id, first_marked_contact_id, first_marked_contact_name, occurrence_count, last_marked_at)
  values (bare, p_reason, now(), auth.uid(), p_deal_id, p_contact_id, p_contact_name, 1, now())
  on conflict (phone) do update
    set occurrence_count = bad_phone_numbers.occurrence_count + 1,
        last_marked_at = now(),
        reason = excluded.reason;
end $fn$;
grant execute on function public.mark_bad_number(text, text, text, uuid, text) to authenticated;
