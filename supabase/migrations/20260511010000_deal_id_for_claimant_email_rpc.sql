-- 2026-05-11 — RPC: find deal_id from a claimant email address.
--
-- Used by portal.html admin-preview path so when admin opens
-- /portal.html?email=X (the same URL we send to clients via Gmail),
-- the admin sees the CLIENT'S deal in preview — not whatever deal
-- happens to be deals[0] (most-recently-updated).
--
-- Pre-fix scare: Nathan tested John Dunn's invite link from his
-- admin browser and saw Kemper Ansel's case load. Looked like a
-- data leak; was actually admin-preview defaulting to wrong deal
-- (last touched in DCC) and ignoring the email URL param. RLS on
-- the actual client path (when John signs in himself) is fine —
-- he sees only his own deal via client_access.user_id scoping.
--
-- Lookup strategy:
--   1. client_access.email matches (case-insensitive) — fast path
--   2. fallback: join client_access → auth.users by user_id, match
--      auth.users.email (for clients where client_access.email is
--      NULL post-signup; same pattern handled by deal_claimants RPC).

create or replace function public.deal_id_for_claimant_email(p_email text)
returns text
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_deal_id text;
  v_email   text := lower(btrim(p_email));
begin
  if not (public.is_admin() or public.is_va()) then
    raise exception 'permission denied';
  end if;

  if v_email is null or v_email = '' then return null; end if;

  -- Fast path: client_access.email
  select deal_id into v_deal_id
  from public.client_access
  where lower(email) = v_email
    and enabled = true
  order by created_at desc
  limit 1;

  if v_deal_id is not null then return v_deal_id; end if;

  -- Fallback: client_access.user_id → auth.users.email
  select ca.deal_id into v_deal_id
  from public.client_access ca
  join auth.users u on u.id = ca.user_id
  where lower(u.email) = v_email
    and ca.enabled = true
  order by ca.created_at desc
  limit 1;

  return v_deal_id;
end;
$$;

comment on function public.deal_id_for_claimant_email(text) is
  'Returns the most-recent enabled client_access.deal_id for a claimant email. Tries client_access.email first, falls back to auth.users.email via user_id. Admin/VA only. Used by portal.html admin-preview to honor ?email= URL param.';

revoke all on function public.deal_id_for_claimant_email(text) from public;
grant execute on function public.deal_id_for_claimant_email(text) to authenticated;
