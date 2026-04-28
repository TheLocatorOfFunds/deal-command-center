-- Admin-only RPC to read website Lauren conversations for a specific deal.
--
-- Website Lauren (lauren-chat EF on refundlocators.com) writes every
-- consumer-facing conversation to public.lauren_conversations. Each
-- conversation captures the personalized_links.token if the visitor
-- was on /s/<token>, OR token=null if they were on a generic page.
--
-- Match path: lauren_conversations.token = personalized_links.token →
-- personalized_links.deal_id. This RPC walks that chain and returns
-- every conversation linked to the deal, plus any from the same
-- visitor_id within the last 30 days (catches cross-page visits).
--
-- Gated by is_admin() — chat content is sensitive.

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

  -- Tokens linked to this deal (usually 1, sometimes more if regenerated)
  select array_agg(token) into v_tokens
  from public.personalized_links
  where deal_id = p_deal_id and token is not null;

  -- Visitor IDs we've seen on those tokens — used to catch the same
  -- person's earlier (token-less) conversations on generic pages.
  select array_agg(distinct visitor_id) into v_visitors
  from public.lauren_conversations
  where token = any(coalesce(v_tokens, array[]::text[]));

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

-- Lighter weight version: just the count, for tab badge rendering.
create or replace function public.lauren_conversations_count_for_deal(p_deal_id text)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tokens text[];
  v_count int;
begin
  if not public.is_admin() then return 0; end if;

  select array_agg(token) into v_tokens
  from public.personalized_links
  where deal_id = p_deal_id and token is not null;

  if v_tokens is null or array_length(v_tokens, 1) is null then
    return 0;
  end if;

  select count(*)::int into v_count
  from public.lauren_conversations
  where token = any(v_tokens);

  return v_count;
end;
$$;
grant execute on function public.lauren_conversations_count_for_deal(text) to authenticated;
