-- Team chat (Phase 1): N + J internal messaging inside DCC.
--
-- Lauren joins in Phase 2 — schema includes lauren_enabled flag + sender_kind
-- of 'lauren' so we don't need a follow-up migration; Phase 2 just flips
-- bot_enabled true on a thread and adds the lauren-team-respond Edge Function.
--
-- RLS model: only admin + va roles can read/write any team thread or
-- message. Clients/attorneys are excluded entirely (it's an internal channel).

create table if not exists public.team_threads (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  created_by   uuid references auth.users(id),
  created_at   timestamptz not null default now(),
  archived_at  timestamptz,
  lauren_enabled boolean not null default false  -- phase 2
);

create table if not exists public.team_messages (
  id          uuid primary key default gen_random_uuid(),
  thread_id   uuid not null references public.team_threads(id) on delete cascade,
  sender_id   uuid references auth.users(id),     -- null for lauren
  sender_kind text not null default 'admin' check (sender_kind in ('admin','va','lauren')),
  body        text not null default '',
  attachments jsonb not null default '[]'::jsonb,  -- [{path,name,size,mime}]
  parent_id   uuid references public.team_messages(id),  -- threading (phase 3)
  created_at  timestamptz not null default now(),
  edited_at   timestamptz,
  deleted_at  timestamptz
);

create index if not exists idx_team_messages_thread on public.team_messages(thread_id, created_at desc);
create index if not exists idx_team_messages_active on public.team_messages(thread_id, created_at desc) where deleted_at is null;

-- Per-user last-read tracker — drives unread badges
create table if not exists public.team_message_reads (
  thread_id    uuid not null references public.team_threads(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (thread_id, user_id)
);

-- Reactions (schema for Phase 3; not surfaced in Phase 1 UI)
create table if not exists public.team_reactions (
  id         uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.team_messages(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  emoji      text not null,
  created_at timestamptz not null default now(),
  unique (message_id, user_id, emoji)
);

-- RLS — admin + va only
alter table public.team_threads enable row level security;
alter table public.team_messages enable row level security;
alter table public.team_message_reads enable row level security;
alter table public.team_reactions enable row level security;

drop policy if exists team_threads_admin_va on public.team_threads;
create policy team_threads_admin_va on public.team_threads
  for all to authenticated
  using (public.is_admin() or public.is_va())
  with check (public.is_admin() or public.is_va());

drop policy if exists team_messages_admin_va on public.team_messages;
create policy team_messages_admin_va on public.team_messages
  for all to authenticated
  using (public.is_admin() or public.is_va())
  with check (public.is_admin() or public.is_va());

drop policy if exists team_message_reads_self on public.team_message_reads;
create policy team_message_reads_self on public.team_message_reads
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists team_reactions_admin_va on public.team_reactions;
create policy team_reactions_admin_va on public.team_reactions
  for all to authenticated
  using (public.is_admin() or public.is_va())
  with check (public.is_admin() or public.is_va());

-- Realtime: stream new messages so both devices see them instantly
alter publication supabase_realtime add table public.team_messages;
alter publication supabase_realtime add table public.team_threads;
alter publication supabase_realtime add table public.team_reactions;

-- Storage bucket for chat attachments — separate from deal-docs because
-- these aren't tied to a specific deal and lifecycle is different.
insert into storage.buckets (id, name, public, file_size_limit)
  values ('team-chat', 'team-chat', false, 5368709120)
  on conflict (id) do update
  set file_size_limit = excluded.file_size_limit,
      allowed_mime_types = null;

-- Storage policies: admins + VAs can upload/read team-chat files
drop policy if exists team_chat_admin_va_select on storage.objects;
create policy team_chat_admin_va_select on storage.objects
  for select to authenticated
  using (bucket_id = 'team-chat' and (public.is_admin() or public.is_va()));

drop policy if exists team_chat_admin_va_insert on storage.objects;
create policy team_chat_admin_va_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'team-chat' and (public.is_admin() or public.is_va()));

drop policy if exists team_chat_admin_va_delete on storage.objects;
create policy team_chat_admin_va_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'team-chat' and (public.is_admin() or public.is_va()));

-- Helper: total unread message count across all threads, for the global
-- nav badge. Counts messages newer than the user's last_read_at on each
-- thread (or all messages if they've never read it).
create or replace function public.team_unread_count(p_user_id uuid default auth.uid())
returns integer
language sql
security definer
set search_path = public
as $$
  select coalesce(sum(
    case
      when r.last_read_at is null then thread_count.cnt
      else (select count(*) from public.team_messages m
            where m.thread_id = thread_count.thread_id
              and m.created_at > r.last_read_at
              and m.sender_id is distinct from p_user_id
              and m.deleted_at is null)
    end
  ), 0)::integer
  from (
    select t.id as thread_id, count(m.*) as cnt
    from public.team_threads t
    left join public.team_messages m on m.thread_id = t.id and m.deleted_at is null and m.sender_id is distinct from p_user_id
    where t.archived_at is null
    group by t.id
  ) thread_count
  left join public.team_message_reads r
    on r.thread_id = thread_count.thread_id and r.user_id = p_user_id;
$$;

grant execute on function public.team_unread_count(uuid) to authenticated;

-- Seed the default "Ops" thread so N + J have somewhere to start without UI
-- thread-creation friction. Other threads can be created from UI in Phase 3.
insert into public.team_threads (title)
select 'Ops' where not exists (select 1 from public.team_threads where title = 'Ops');
