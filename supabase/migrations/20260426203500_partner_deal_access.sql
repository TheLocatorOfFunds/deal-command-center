-- Token-based JV partner portal — same shape as investor_deal_access, but a
-- partner sees MORE: their profit share %, the buyer + title contacts, a
-- subset of tasks they're responsible for, and they can write back (mark
-- tasks complete + post updates that show up in DCC activity).
--
-- A "partner" here = someone Nathan brings on for a specific deal in exchange
-- for a profit share (e.g. Kevin getting 25% of Casey Jennings to manage
-- pictures, buyer, title, close, handoff). Not a global team member, not an
-- investor — scoped to ONE deal at a time, no signup, opaque-token auth.

create table if not exists public.partner_deal_access (
  id uuid primary key default gen_random_uuid(),
  deal_id text not null references public.deals(id) on delete cascade,
  token uuid not null unique default gen_random_uuid(),
  partner_name text,
  partner_email text,
  partner_phone text,
  profit_share_pct numeric(5,2) not null default 25.00,
  role_description text,                                -- e.g. "Photos, buyer, title, close, handoff"
  notes text,
  invited_by uuid references auth.users(id),
  invited_at timestamptz not null default now(),
  enabled boolean not null default true,
  revoked_at timestamptz,
  last_viewed_at timestamptz,
  view_count integer not null default 0
);

create index if not exists idx_partner_deal_access_deal on public.partner_deal_access(deal_id, invited_at desc);
create index if not exists idx_partner_deal_access_token on public.partner_deal_access(token);

alter table public.partner_deal_access enable row level security;

drop policy if exists admin_all_partner_access on public.partner_deal_access;
create policy admin_all_partner_access on public.partner_deal_access
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists va_manage_partner_access on public.partner_deal_access;
create policy va_manage_partner_access on public.partner_deal_access
  for all to authenticated using (public.is_va()) with check (public.is_va());

-- Partner-visible flags (independent of investor_visible — different audiences).
alter table public.documents
  add column if not exists partner_visible boolean not null default false;

create index if not exists idx_documents_partner_visible
  on public.documents(deal_id) where partner_visible = true;

alter table public.tasks
  add column if not exists partner_visible boolean not null default false;

alter table public.tasks
  add column if not exists completed_by_partner_at timestamptz;

create index if not exists idx_tasks_partner_visible
  on public.tasks(deal_id) where partner_visible = true;

-- Token resolver. Returns deal info + profit-share + partner-flagged docs +
-- partner-flagged tasks + buyer/title contacts pulled from deal.meta.partner.
-- SECURITY DEFINER so anon callers can use it without exposing tables.
create or replace function public.get_partner_deal_by_token(p_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  access_row    public.partner_deal_access%rowtype;
  deal_row      public.deals%rowtype;
  partner_meta  jsonb;
  docs          jsonb;
  task_rows     jsonb;
  activity_rows jsonb;
  result        jsonb;
begin
  if p_token is null then return null; end if;

  select * into access_row
  from public.partner_deal_access
  where token = p_token and enabled = true and revoked_at is null;
  if not found then return null; end if;

  select * into deal_row from public.deals where id = access_row.deal_id;
  if not found then return null; end if;

  update public.partner_deal_access
  set last_viewed_at = now(), view_count = view_count + 1
  where id = access_row.id;

  partner_meta := coalesce(deal_row.meta->'partner', '{}'::jsonb);

  -- Documents flagged partner-visible (photos + any docs Nathan exposed)
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', d.id,
    'name', d.name,
    'path', d.path,
    'size', d.size,
    'created_at', d.created_at,
    'document_type', d.extracted->>'document_type',
    'is_cover', (d.path = (partner_meta->>'coverPhotoPath')),
    'is_image', (d.name ~* '\.(jpg|jpeg|png|webp|heic|gif)$')
  ) order by d.created_at asc), '[]'::jsonb)
  into docs
  from public.documents d
  where d.deal_id = deal_row.id and d.partner_visible = true;

  -- Tasks flagged partner-visible. coalesce(title, label) because the UI
  -- writes to `label` while the docket-trigger writes to `title` — both live.
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', t.id,
    'title', coalesce(t.title, t.label),
    'done', t.done,
    'due_date', coalesce(t.due_date::text, t.due),
    'completed_by_partner_at', t.completed_by_partner_at
  ) order by t.done asc, coalesce(t.due_date::text, t.due) nulls last, t.created_at asc), '[]'::jsonb)
  into task_rows
  from public.tasks t
  where t.deal_id = deal_row.id and t.partner_visible = true;

  -- Recent activity (last 30 entries) so Kevin sees what's happening
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', a.id,
    'action', a.action,
    'created_at', a.created_at,
    'author', coalesce(p.name, 'Team')
  ) order by a.created_at desc), '[]'::jsonb)
  into activity_rows
  from (
    select * from public.activity
    where deal_id = deal_row.id
    order by created_at desc
    limit 30
  ) a
  left join public.profiles p on p.id = a.user_id;

  result := jsonb_build_object(
    'access_id', access_row.id,
    'partner_name', access_row.partner_name,
    'partner_email', access_row.partner_email,
    'partner_phone', access_row.partner_phone,
    'profit_share_pct', access_row.profit_share_pct,
    'role_description', access_row.role_description,
    'invited_at', access_row.invited_at,
    'deal', jsonb_build_object(
      'id', deal_row.id,
      'name', deal_row.name,
      'headline_address', deal_row.address,
      'county', deal_row.meta->>'county',
      'type', deal_row.type,
      'status', deal_row.status,
      'partner', partner_meta
    ),
    'documents', docs,
    'tasks', task_rows,
    'activity', activity_rows,
    'cover_photo_path', partner_meta->>'coverPhotoPath'
  );

  return result;
end;
$$;

grant execute on function public.get_partner_deal_by_token(uuid) to anon, authenticated;

-- Signed download URL for a partner-visible doc. Validates token + visibility
-- before returning the storage path (front-end then calls createSignedUrl).
create or replace function public.get_partner_document_url(p_token uuid, p_document_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  doc_path text;
begin
  if p_token is null or p_document_id is null then return null; end if;

  select d.path into doc_path
  from public.documents d
  join public.partner_deal_access a on a.deal_id = d.deal_id
  where d.id = p_document_id
    and d.partner_visible = true
    and a.token = p_token
    and a.enabled = true
    and a.revoked_at is null;
  if not found then return null; end if;

  return doc_path;
end;
$$;

grant execute on function public.get_partner_document_url(uuid, uuid) to anon, authenticated;

-- Partner marks a task complete. Token-validated. Logs activity row so Nathan
-- sees it in DCC ("Kevin marked: Pictures done").
create or replace function public.partner_complete_task(
  p_token uuid,
  p_task_id uuid,
  p_done boolean default true
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  access_row public.partner_deal_access%rowtype;
  task_row   public.tasks%rowtype;
begin
  if p_token is null or p_task_id is null then return false; end if;

  select * into access_row
  from public.partner_deal_access
  where token = p_token and enabled = true and revoked_at is null;
  if not found then return false; end if;

  select * into task_row from public.tasks
  where id = p_task_id and deal_id = access_row.deal_id and partner_visible = true;
  if not found then return false; end if;

  update public.tasks
  set done = p_done,
      completed_by_partner_at = case when p_done then now() else null end
  where id = p_task_id;

  insert into public.activity(deal_id, user_id, action)
  values (
    access_row.deal_id,
    null,
    coalesce(access_row.partner_name, 'Partner') ||
      case when p_done then ' marked task complete: ' else ' reopened task: ' end ||
      coalesce(task_row.title, task_row.label, '(task)')
  );

  return true;
end;
$$;

grant execute on function public.partner_complete_task(uuid, uuid, boolean) to anon, authenticated;

-- Partner posts a free-form update. Goes into activity feed so Nathan sees it
-- in DCC and on the deal timeline.
create or replace function public.partner_post_update(
  p_token uuid,
  p_message text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  access_row public.partner_deal_access%rowtype;
  trimmed    text := trim(coalesce(p_message, ''));
begin
  if p_token is null or length(trimmed) = 0 then return false; end if;
  if length(trimmed) > 2000 then return false; end if;  -- guard

  select * into access_row
  from public.partner_deal_access
  where token = p_token and enabled = true and revoked_at is null;
  if not found then return false; end if;

  insert into public.activity(deal_id, user_id, action)
  values (
    access_row.deal_id,
    null,
    coalesce(access_row.partner_name, 'Partner') || ' (JV): ' || trimmed
  );

  return true;
end;
$$;

grant execute on function public.partner_post_update(uuid, text) to anon, authenticated;

comment on table public.partner_deal_access is
  'Token-based JV partner access (e.g. Kevin gets 25% of Casey Jennings to manage pictures, buyer, title, close). One row = one partner on one deal. Read+write back via partner_complete_task + partner_post_update RPCs.';
