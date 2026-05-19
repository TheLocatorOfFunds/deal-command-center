-- 2026-05-11 — RPC that resolves client_access.email from auth.users when null.
--
-- Bug: for some claimants `client_access.email` is NULL even though
-- `user_id` is set (they've signed in). The DCC Client Portal card
-- then renders "Client" as the row label and hides the Copy invite
-- link + Email-now buttons (both gated on row.email). Nathan can't
-- see which email belongs to which claimant or grab a sharable
-- portal link per row.
--
-- Fix: a SECURITY DEFINER RPC that joins client_access with auth.users
-- and returns the resolved email via coalesce(ca.email, u.email).
-- Admins/VAs only — clients should never see other claimants' emails.
--
-- Why an RPC vs. backfilling client_access.email:
-- 1. Some flows may legitimately want email cleared in client_access
--    post-signup (privacy). The auth.users.email stays as the
--    canonical source. RPC reads through, no double-write to keep in sync.
-- 2. RLS on client_access permits admin/va, but auth.users is locked
--    down — the SECURITY DEFINER context bridges it cleanly.

create or replace function public.deal_claimants(p_deal_id text)
returns table (
  id           uuid,
  user_id      uuid,
  email        text,
  enabled      boolean,
  last_seen_at timestamptz,
  prefs        jsonb,
  created_at   timestamptz
)
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if not (public.is_admin() or public.is_va()) then
    raise exception 'permission denied';
  end if;

  return query
  select
    ca.id,
    ca.user_id,
    coalesce(ca.email, u.email)::text as email,
    ca.enabled,
    ca.last_seen_at,
    ca.prefs,
    ca.created_at
  from public.client_access ca
  left join auth.users u on u.id = ca.user_id
  where ca.deal_id = p_deal_id
  order by ca.created_at;
end;
$$;

comment on function public.deal_claimants(text) is
  'Returns per-deal claimants with email resolved via coalesce(client_access.email, auth.users.email). Admin/VA only. Used by the Client Portal card in DCC to surface real emails even when client_access.email is NULL post-signup.';

revoke all on function public.deal_claimants(text) from public;
grant execute on function public.deal_claimants(text) to authenticated;
