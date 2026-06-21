-- "✓ Reviewed" button → stamps meta.review_cleared_at (merge-safe, server-side) so the
-- lead drops out of v_lead_review_queue. Human action only; no judgment by the system.
-- p_clear=false un-clears (puts it back) for an undo. Admin/VA only.
create or replace function public.clear_lead_review(p_deal_id text, p_clear boolean default true)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not (public.is_admin() or public.is_va()) then raise exception 'not authorized'; end if;
  if p_clear then
    update public.deals set meta = coalesce(meta,'{}'::jsonb) || jsonb_build_object('review_cleared_at', now()::text) where id = p_deal_id;
    insert into public.activity (deal_id, user_id, action, visibility) values (p_deal_id, auth.uid(), '🔎 Marked reviewed (cleared from review queue)', array['team']);
  else
    update public.deals set meta = (coalesce(meta,'{}'::jsonb) - 'review_cleared_at') where id = p_deal_id;
  end if;
end $$;
grant execute on function public.clear_lead_review(text, boolean) to authenticated;
