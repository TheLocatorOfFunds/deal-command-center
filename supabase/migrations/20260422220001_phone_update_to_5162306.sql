-- Flip outbound phone in trigger/RPC email bodies.
-- Unified GHL number (513) 951-8855 is being retired in favor of Nathan's
-- iPhone (513) 516-2306, which is the number every portal + edge function
-- now points to. This migration rewrites any public.* function whose body
-- contains the old number, following the pg_get_functiondef → replace →
-- execute pattern from 20260422020647_fix_team_email_recipient_to_fundlocators.
-- Order matters: replace '+15139518855' before '5139518855' so the longer
-- string doesn't get double-processed.

do $$
declare
  r record;
  src text;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and (p.prosrc ilike '%9518855%' or p.prosrc ilike '%951-8855%')
  loop
    src := pg_get_functiondef(r.sig);
    src := replace(src, '+15139518855', '+15135162306');
    src := replace(src, '(513) 951-8855', '(513) 516-2306');
    src := replace(src, '5139518855', '5135162306');
    execute src;
  end loop;
end $$;
