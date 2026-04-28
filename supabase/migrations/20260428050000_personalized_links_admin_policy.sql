-- Fix: clicking "Generate personalized URL" on a deal threw
--   "new row violates row-level security policy for table 'personalized_links'"
--
-- The personalized_links table is Castle-owned — Castle's scraper writes
-- new rows via the service role, which bypasses RLS. The DCC frontend
-- (PersonalizedUrlControl in src/app.jsx) does a direct
-- `sb.from('personalized_links').insert(...)` from the user's
-- authenticated session, which IS gated by RLS. Existing policies allow
-- SELECT (Nathan can read his leads) but not INSERT or UPDATE.
--
-- Add a permissive admin policy so Nathan/Justin can mint personalized
-- URLs from the deal detail page. Idempotent — safe to re-apply.

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'personalized_links'
      and policyname = 'admin_all_personalized_links'
  ) then
    create policy admin_all_personalized_links on public.personalized_links
      for all to authenticated
      using      (public.is_admin())
      with check (public.is_admin());
  end if;
end $$;
