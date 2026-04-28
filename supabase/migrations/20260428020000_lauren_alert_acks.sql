-- Lauren alert acknowledgments — DCC-side state for "Nathan/Justin
-- has seen this flagged Lauren conversation" without touching Justin's
-- lauren_conversations schema.
--
-- Workflow:
-- 1. Website Lauren writes to public.lauren_conversations as visitors chat.
-- 2. lauren_flagged_conversations() RPC scans for keyword matches in
--    transcripts, joins to personalized_links → deals, and returns the
--    ones not yet in lauren_alert_acks.
-- 3. Nathan clicks an alert → lauren_ack_flagged(conversation_id) inserts
--    into lauren_alert_acks. Counts drop. Badge clears.

create table if not exists public.lauren_alert_acks (
  conversation_id uuid primary key references public.lauren_conversations(id) on delete cascade,
  acknowledged_at timestamptz not null default now(),
  acknowledged_by uuid references auth.users(id)
);

alter table public.lauren_alert_acks enable row level security;
drop policy if exists lauren_alert_acks_admin on public.lauren_alert_acks;
create policy lauren_alert_acks_admin on public.lauren_alert_acks
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Keyword regex for "alarm" terms — when any user-role message in a
-- conversation contains one of these, it's flagged for Nathan to read.
-- Conservative list; tune as we learn.
-- (Encoded as a single regex to keep the RPC tight.)
-- scam, legit, sue, lawyer, attorney general, AG, complaint, refund,
-- cancel, fraud, trust, real, catch
-- Word boundaries on most; "AG" gets uppercase-only to avoid false positives.

create or replace function public.lauren_flagged_conversations()
returns table(
  id uuid,
  visitor_id text,
  started_at timestamptz,
  last_message_at timestamptz,
  page_origin text,
  token text,
  message_count int,
  submitted_claim boolean,
  transcript jsonb,
  deal_id text,
  deal_name text,
  first_user_msg text
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
    with flagged as (
      select c.*
      from public.lauren_conversations c
      where exists (
        select 1
        from jsonb_array_elements(c.transcript) m
        where m->>'role' = 'user'
          and (
            m->>'content' ~* '\m(scam|legit|sue|lawyer|attorney general|complaint|refund|cancel|fraud|catch)\M'
            or m->>'content' ~ '\mAG\M'
          )
      )
      and not exists (select 1 from public.lauren_alert_acks a where a.conversation_id = c.id)
      and c.started_at > now() - interval '60 days'
    )
    select
      f.id, f.visitor_id, f.started_at, f.last_message_at,
      f.page_origin, f.token, f.message_count, f.submitted_claim, f.transcript,
      pl.deal_id,
      d.name as deal_name,
      (
        select left(m->>'content', 200)
        from jsonb_array_elements(f.transcript) m
        where m->>'role' = 'user'
        limit 1
      ) as first_user_msg
    from flagged f
    left join public.personalized_links pl on pl.token = f.token
    left join public.deals d on d.id = pl.deal_id
    order by f.last_message_at desc
    limit 100;
end;
$$;
grant execute on function public.lauren_flagged_conversations() to authenticated;

-- Lightweight count for the header badge.
create or replace function public.lauren_flagged_count()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  if not public.is_admin() then return 0; end if;
  select count(*)::int into v_count
  from public.lauren_conversations c
  where exists (
    select 1 from jsonb_array_elements(c.transcript) m
    where m->>'role' = 'user'
      and (
        m->>'content' ~* '\m(scam|legit|sue|lawyer|attorney general|complaint|refund|cancel|fraud|catch)\M'
        or m->>'content' ~ '\mAG\M'
      )
  )
  and not exists (select 1 from public.lauren_alert_acks a where a.conversation_id = c.id)
  and c.started_at > now() - interval '60 days';
  return v_count;
end;
$$;
grant execute on function public.lauren_flagged_count() to authenticated;

-- Acknowledge (mark seen) — clears the alert from the inbox.
create or replace function public.lauren_ack_flagged(p_conversation_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
begin
  if not public.is_admin() then raise exception 'admins only'; end if;
  insert into public.lauren_alert_acks (conversation_id, acknowledged_by)
  values (p_conversation_id, v_user)
  on conflict (conversation_id) do update
    set acknowledged_at = now(), acknowledged_by = v_user;
end;
$$;
grant execute on function public.lauren_ack_flagged(uuid) to authenticated;

-- Bulk ack — for the "Acknowledge all" button.
create or replace function public.lauren_ack_all_flagged()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_count int;
begin
  if not public.is_admin() then raise exception 'admins only'; end if;
  with flagged as (
    select id from public.lauren_conversations c
    where exists (
      select 1 from jsonb_array_elements(c.transcript) m
      where m->>'role' = 'user'
        and (
          m->>'content' ~* '\m(scam|legit|sue|lawyer|attorney general|complaint|refund|cancel|fraud|catch)\M'
          or m->>'content' ~ '\mAG\M'
        )
    )
    and c.started_at > now() - interval '60 days'
  )
  insert into public.lauren_alert_acks (conversation_id, acknowledged_by)
  select id, v_user from flagged
  on conflict (conversation_id) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
grant execute on function public.lauren_ack_all_flagged() to authenticated;
