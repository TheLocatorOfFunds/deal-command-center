-- Fix: lauren_conversations_for_deal threw
-- "column reference 'token' is ambiguous" on every call.
--
-- The function RETURNS TABLE(... token text ...), which exposes `token`
-- as an output identifier inside the function body. Unqualified
-- references to `token` in the helper SELECTs collided with that.
-- Table-aliasing (pl., lc.) disambiguates without changing behavior.

create or replace function public.lauren_conversations_for_deal(p_deal_id text)
returns table(
  id uuid,
  visitor_id text,
  started_at timestamptz,
  last_message_at timestamptz,
  page_origin text,
  token text,
  seed_message text,
  message_count int,
  submitted_claim boolean,
  transcript jsonb,
  matched_via text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tokens text[];
  v_visitors text[];
begin
  if not public.is_admin() then
    raise exception 'admins only';
  end if;

  select array_agg(pl.token) into v_tokens
  from public.personalized_links pl
  where pl.deal_id = p_deal_id and pl.token is not null;

  select array_agg(distinct lc.visitor_id) into v_visitors
  from public.lauren_conversations lc
  where lc.token = any(coalesce(v_tokens, array[]::text[]));

  return query
    select
      c.id, c.visitor_id, c.started_at, c.last_message_at,
      c.page_origin, c.token, c.seed_message, c.message_count,
      c.submitted_claim, c.transcript,
      case
        when c.token = any(coalesce(v_tokens, array[]::text[])) then 'token'
        else 'visitor'
      end as matched_via
    from public.lauren_conversations c
    where
      c.token = any(coalesce(v_tokens, array[]::text[]))
      or (
        v_visitors is not null
        and c.visitor_id = any(v_visitors)
        and c.started_at > now() - interval '30 days'
      )
    order by c.started_at desc
    limit 100;
end;
$$;
grant execute on function public.lauren_conversations_for_deal(text) to authenticated;
