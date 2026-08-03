-- F-35 audit Phase 1 (2026-08-03): list-payload trim.
-- meta.case_intel_summary (the AI briefs) was ~400KB ≈ 1/3 of the deals list
-- payload. v_deals_list serves the list WITHOUT it; CaseIntelligence fetches
-- the brief per-deal on open. security_invoker so deals RLS applies unchanged.
-- Column list is generated so the view tracks schema changes on re-run.
do $$
declare cols text; ddl text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    into cols
  from information_schema.columns
  where table_schema='public' and table_name='deals' and column_name <> 'meta';
  ddl := format(
    'create or replace view public.v_deals_list with (security_invoker = true) as select %s, (meta - %L) as meta from public.deals',
    cols, 'case_intel_summary');
  execute ddl;
end $$;
grant select on public.v_deals_list to authenticated;
