-- Admin-only RPC to surface auth.users metadata in the Team modal.
--
-- Joins public.profiles with auth.users so admins can see:
--   last_sign_in_at      — actually signed in vs. invited and ghosted
--   email_confirmed_at   — confirmed via magic link or not
--   has_password         — password set vs. magic-link only
--
-- auth.users is otherwise inaccessible from anon/authenticated; this function
-- is SECURITY DEFINER and gated by is_admin() at the top, so only admins
-- can call it. VAs / attorneys / clients get an exception.

create or replace function public.admin_get_team_users()
returns table(
  id uuid,
  email text,
  name text,
  display_name text,
  role text,
  avatar_path text,
  last_sign_in_at timestamptz,
  email_confirmed_at timestamptz,
  has_password boolean,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'admins only';
  end if;
  return query
    select p.id,
           u.email::text,
           p.name,
           p.display_name,
           p.role,
           p.avatar_path,
           u.last_sign_in_at,
           u.email_confirmed_at,
           (u.encrypted_password is not null and u.encrypted_password <> '') as has_password,
           p.created_at
    from public.profiles p
    join auth.users u on u.id = p.id
    order by p.role nulls last, coalesce(p.name, '');
end;
$$;

grant execute on function public.admin_get_team_users() to authenticated;
