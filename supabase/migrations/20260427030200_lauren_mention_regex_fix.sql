-- Fix Lauren's @-mention detection regex.
--
-- The Phase 2 migration (20260427020000) used '@lauren\b' assuming Perl/JS
-- word-boundary semantics. PostgreSQL POSIX/ARE regex (used by ~*) treats
-- \b as the backspace character (0x08), not a word boundary. Result:
-- '@lauren test', '@lauren', and 'hey @lauren!' all returned false. The
-- only mention pattern that ever fired was '^\s*lauren[,:]' / '^\s*L:'.
--
-- Fix: replace \b with \y, PostgreSQL's word-boundary token in ARE regex.
-- (\y matches at the start or end of a word; the other variants \m / \M
-- match only start or only end. \y is the right one here.)

create or replace function public.lauren_is_mentioned(p_body text)
returns boolean
language sql
immutable
as $$
  select coalesce(p_body, '') ~* '(@lauren\y|^\s*lauren[,:]|^\s*L:)';
$$;
