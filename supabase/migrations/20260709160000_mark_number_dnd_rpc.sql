-- Per-number do-not-contact (Nathan 2026-07-09, the Pal Kis opt-out).
-- The disposition modal's DND propagation matched contacts by EXACT phone
-- string, so numbers stored formatted ("(216) 240-6688") were silently missed
-- (0-row update) — Pal Kis texted an explicit harassment/lawyer opt-out and
-- still had do_not_call=false. This RPC normalizes BOTH sides to bare digits
-- and flags every contact whose phone list contains the number: calls AND
-- texts blocked (an opt-out stops contact with the person, both channels).
create or replace function public.mark_number_dnd(p_phone text, p_reason text default null, p_status text default null)
returns integer language plpgsql security invoker set search_path to 'public' as $fn$
declare
  bare text := right(regexp_replace(coalesce(p_phone,''), '\D', '', 'g'), 10);
  n integer;
begin
  if length(bare) < 7 then return 0; end if;
  update contacts
     set do_not_call = true,
         do_not_text = true,
         dnd_set_at = now(),
         dnd_reason = coalesce(p_reason, dnd_reason, 'Marked do-not-contact (per-number)'),
         phone_status = coalesce(p_status, phone_status)
   where regexp_replace(coalesce(phone,''), '\D', '', 'g') like '%' || bare || '%';
  get diagnostics n = row_count;
  return n;
end $fn$;
grant execute on function public.mark_number_dnd(text, text, text) to authenticated;
