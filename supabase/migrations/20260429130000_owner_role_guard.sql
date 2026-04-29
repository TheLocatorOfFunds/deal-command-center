-- Server-side enforcement of OWNER_EMAILS — only Nathan + Justin can change
-- profile roles, even via the SQL editor or a direct supabase-js call.
--
-- Per Nathan 2026-04-29: the client-side OWNER_EMAILS gate in src/app.jsx is
-- a UX fence, not a security boundary. A determined admin who knows the
-- schema could SQL-update their own profile.role to 'admin' and bypass the
-- gate. This trigger rejects any role change unless the caller's email is
-- in the owner allowlist below.
--
-- Sync this list with OWNER_EMAILS in src/app.jsx whenever owners change.

create or replace function public.is_owner()
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_email text;
begin
  select lower(email) into v_email from auth.users where id = auth.uid();
  return v_email in (
    'nathan@fundlocators.com',
    'nathan@refundlocators.com',
    'justin@fundlocators.com',
    'justin@refundlocators.com'
  );
end;
$$;

grant execute on function public.is_owner() to authenticated;

-- Trigger: reject role changes by non-owners. Allows other profile column
-- updates (name, avatar, phone, etc.) to flow through normally.
create or replace function public.guard_profiles_role_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.role is distinct from OLD.role and not public.is_owner() then
    raise exception 'only owners can change profile roles (current: %, attempted: %)',
      OLD.role, NEW.role
      using errcode = '42501'; -- insufficient_privilege
  end if;
  return NEW;
end;
$$;

drop trigger if exists tg_guard_profiles_role on public.profiles;
create trigger tg_guard_profiles_role
  before update on public.profiles
  for each row
  when (new.role is distinct from old.role)
  execute function public.guard_profiles_role_change();
