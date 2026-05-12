-- Expose the relay schema to PostgREST so that supabase-js .schema('relay') works.
-- Supabase hosted PostgREST only serves schemas listed in pgrst.db-schemas.
-- Default set is: public, storage, graphql_public.
-- We append relay to that list.

ALTER ROLE authenticator SET "pgrst.db-schemas" TO 'public,storage,graphql_public,relay';
NOTIFY pgrst, 'reload config';

-- Ensure the anon and authenticated roles can use the relay schema
-- (service_role already has this from the schema creation migration)
GRANT USAGE ON SCHEMA relay TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA relay TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA relay TO service_role;

-- Future tables in relay schema also get the grants
ALTER DEFAULT PRIVILEGES IN SCHEMA relay
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA relay
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO service_role;
