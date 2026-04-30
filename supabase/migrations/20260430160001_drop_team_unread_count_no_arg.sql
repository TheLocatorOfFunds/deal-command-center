-- Drop the no-arg team_unread_count() I added in 20260430160000.
--
-- An existing team_unread_count(p_user_id uuid) was already in the DB
-- (from earlier team-chat work). Postgres can't choose between two
-- overloads when the client calls with no body, so client calls were
-- erroring with "Could not choose the best candidate function".
--
-- The existing 1-arg version does the right thing — App passes the
-- user's id explicitly. Dropping the no-arg overload restores
-- single-candidate dispatch.

drop function if exists public.team_unread_count();
