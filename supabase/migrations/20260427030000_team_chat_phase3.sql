-- Phase 3: multi-thread + reactions + edit/delete + Lauren write proposals.
-- Idempotent — safe to re-run.

-- ── Multi-thread support ─────────────────────────────────────────────
alter table public.team_threads
  add column if not exists thread_type text not null default 'channel'
    check (thread_type in ('channel','dm','deal')),
  add column if not exists deal_id text references public.deals(id) on delete cascade,
  add column if not exists created_by_id uuid references auth.users(id);

create index if not exists idx_team_threads_deal on public.team_threads(deal_id) where deal_id is not null;
create index if not exists idx_team_threads_type on public.team_threads(thread_type);

create table if not exists public.team_thread_participants (
  thread_id uuid not null references public.team_threads(id) on delete cascade,
  user_id   uuid not null references auth.users(id) on delete cascade,
  added_at  timestamptz not null default now(),
  primary key (thread_id, user_id)
);

alter table public.team_thread_participants enable row level security;

drop policy if exists ttp_admin_va on public.team_thread_participants;
create policy ttp_admin_va on public.team_thread_participants
  for all to authenticated
  using (public.is_admin() or public.is_va())
  with check (public.is_admin() or public.is_va());

-- Realtime: only add to publication if not already there
do $$
begin
  if not exists (
    select 1 from pg_publication_tables where pubname = 'supabase_realtime'
      and schemaname = 'public' and tablename = 'team_thread_participants'
  ) then
    alter publication supabase_realtime add table public.team_thread_participants;
  end if;
end $$;

-- DM-aware thread access: channels + deal threads open to all admin/va,
-- DMs only to participants
drop policy if exists team_threads_admin_va on public.team_threads;
create policy team_threads_admin_va on public.team_threads
  for all to authenticated
  using (
    (public.is_admin() or public.is_va())
    and (
      thread_type != 'dm'
      or exists (
        select 1 from public.team_thread_participants tp
        where tp.thread_id = team_threads.id and tp.user_id = auth.uid()
      )
    )
  )
  with check (public.is_admin() or public.is_va());

-- DM-aware message access: same gating, correlated to the parent thread
drop policy if exists team_messages_admin_va on public.team_messages;
create policy team_messages_admin_va on public.team_messages
  for all to authenticated
  using (
    (public.is_admin() or public.is_va())
    and exists (
      select 1 from public.team_threads t
      where t.id = team_messages.thread_id
        and (
          t.thread_type != 'dm'
          or exists (
            select 1 from public.team_thread_participants tp
            where tp.thread_id = t.id and tp.user_id = auth.uid()
          )
        )
    )
  )
  with check (public.is_admin() or public.is_va());

-- DM creator: dedupes existing DMs between the same two people
create or replace function public.team_create_dm(p_other_user uuid, p_title text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_thread_id uuid;
  v_caller uuid := auth.uid();
  v_label text;
begin
  if v_caller is null then raise exception 'not authenticated'; end if;
  if v_caller = p_other_user then raise exception 'cannot DM yourself'; end if;

  if p_title is null then
    select coalesce(display_name, name, 'You') || ' <-> ' ||
      coalesce(
        (select coalesce(display_name, name, 'Teammate') from public.profiles where id = p_other_user),
        'Teammate'
      )
    from public.profiles where id = v_caller into v_label;
  else
    v_label := p_title;
  end if;

  select t.id into v_thread_id
  from public.team_threads t
  where t.thread_type = 'dm'
    and exists (
      select 1 from public.team_thread_participants tp
      where tp.thread_id = t.id and tp.user_id = v_caller
    )
    and exists (
      select 1 from public.team_thread_participants tp
      where tp.thread_id = t.id and tp.user_id = p_other_user
    )
    and (select count(*) from public.team_thread_participants where thread_id = t.id) = 2
  limit 1;

  if v_thread_id is not null then return v_thread_id; end if;

  insert into public.team_threads (title, thread_type, created_by_id)
  values (v_label, 'dm', v_caller)
  returning id into v_thread_id;

  insert into public.team_thread_participants (thread_id, user_id) values
    (v_thread_id, v_caller),
    (v_thread_id, p_other_user);

  return v_thread_id;
end;
$$;

grant execute on function public.team_create_dm(uuid, text) to authenticated;

-- Per-deal thread getter / creator
create or replace function public.team_get_or_create_deal_thread(p_deal_id text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_thread_id uuid;
  v_deal record;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select id, name, address into v_deal from public.deals where id = p_deal_id;
  if not found then raise exception 'deal not found: %', p_deal_id; end if;

  select id into v_thread_id from public.team_threads
    where deal_id = p_deal_id and thread_type = 'deal' limit 1;
  if v_thread_id is not null then return v_thread_id; end if;

  insert into public.team_threads (title, thread_type, deal_id, lauren_enabled, created_by_id)
  values (
    coalesce(v_deal.name, v_deal.address, p_deal_id),
    'deal', p_deal_id, true, auth.uid()
  )
  returning id into v_thread_id;

  return v_thread_id;
end;
$$;

grant execute on function public.team_get_or_create_deal_thread(text) to authenticated;

-- ── Lauren's pending write actions ───────────────────────────────────
create table if not exists public.lauren_pending_actions (
  id              uuid primary key default gen_random_uuid(),
  thread_id       uuid references public.team_threads(id) on delete cascade,
  message_id      uuid references public.team_messages(id) on delete cascade,
  action_type     text not null check (action_type in ('update_deal_status','create_task','update_deal_meta')),
  action_label    text not null,
  action_payload  jsonb not null,
  status          text not null default 'pending'
    check (status in ('pending','confirmed','rejected','executed','failed','expired')),
  created_at      timestamptz not null default now(),
  decided_at      timestamptz,
  decided_by      uuid references auth.users(id),
  result          jsonb,
  expires_at      timestamptz not null default (now() + interval '24 hours')
);

create index if not exists idx_lauren_actions_thread on public.lauren_pending_actions(thread_id, created_at desc);
create index if not exists idx_lauren_actions_message on public.lauren_pending_actions(message_id);

alter table public.lauren_pending_actions enable row level security;
drop policy if exists lauren_actions_admin_va on public.lauren_pending_actions;
create policy lauren_actions_admin_va on public.lauren_pending_actions
  for all to authenticated
  using (public.is_admin() or public.is_va())
  with check (public.is_admin() or public.is_va());

do $$
begin
  if not exists (
    select 1 from pg_publication_tables where pubname = 'supabase_realtime'
      and schemaname = 'public' and tablename = 'lauren_pending_actions'
  ) then
    alter publication supabase_realtime add table public.lauren_pending_actions;
  end if;
end $$;

-- Executor: applies a pending action with audit logging
create or replace function public.lauren_execute_action(p_action_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_action public.lauren_pending_actions%rowtype;
  v_payload jsonb;
  v_result jsonb;
  v_caller uuid := auth.uid();
begin
  if v_caller is null then raise exception 'not authenticated'; end if;
  select * into v_action from public.lauren_pending_actions where id = p_action_id for update;
  if not found then raise exception 'action not found'; end if;
  if v_action.status != 'pending' then
    return jsonb_build_object('error', 'already ' || v_action.status);
  end if;
  if v_action.expires_at < now() then
    update public.lauren_pending_actions set status = 'expired' where id = p_action_id;
    return jsonb_build_object('error', 'expired');
  end if;

  v_payload := v_action.action_payload;

  begin
    if v_action.action_type = 'update_deal_status' then
      update public.deals set status = (v_payload->>'status') where id = (v_payload->>'deal_id');
      v_result := jsonb_build_object('ok', true, 'updated', 'deals.status');
      insert into public.activity (deal_id, user_id, action) values (
        v_payload->>'deal_id', v_caller,
        format('Status set to %s by Lauren (confirmed by %s)',
          v_payload->>'status',
          coalesce((select name from public.profiles where id = v_caller), 'team'))
      );
    elsif v_action.action_type = 'update_deal_meta' then
      update public.deals
        set meta = coalesce(meta, '{}'::jsonb) || (v_payload->'meta_patch')
        where id = (v_payload->>'deal_id');
      v_result := jsonb_build_object('ok', true, 'updated', 'deals.meta');
    elsif v_action.action_type = 'create_task' then
      insert into public.tasks (deal_id, title, due_date, assigned_to)
      values (
        v_payload->>'deal_id',
        v_payload->>'title',
        (v_payload->>'due_date')::date,
        v_payload->>'assigned_to'
      )
      returning jsonb_build_object('task_id', id) into v_result;
    else
      raise exception 'unknown action type: %', v_action.action_type;
    end if;

    update public.lauren_pending_actions
      set status = 'executed', decided_at = now(), decided_by = v_caller, result = v_result
      where id = p_action_id;
    return v_result;
  exception when others then
    update public.lauren_pending_actions
      set status = 'failed', decided_at = now(), decided_by = v_caller,
          result = jsonb_build_object('error', sqlerrm)
      where id = p_action_id;
    return jsonb_build_object('error', sqlerrm);
  end;
end;
$$;

grant execute on function public.lauren_execute_action(uuid) to authenticated;

create or replace function public.lauren_reject_action(p_action_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.lauren_pending_actions
    set status = 'rejected', decided_at = now(), decided_by = auth.uid()
    where id = p_action_id and status = 'pending';
$$;

grant execute on function public.lauren_reject_action(uuid) to authenticated;

-- Mark existing Ops thread as a 'channel' (no-op if already)
update public.team_threads set thread_type = 'channel'
  where title = 'Ops' and thread_type = 'channel';
