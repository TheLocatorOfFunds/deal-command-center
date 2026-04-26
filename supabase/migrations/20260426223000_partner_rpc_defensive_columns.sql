-- Fix get_partner_deal_by_token: use to_jsonb()->>'col' instead of bare
-- column references for tasks.label / tasks.due so the RPC doesn't fail
-- when those legacy columns are missing on a given tasks row. Same idea
-- for activity row authorship — keep it null-safe end to end.
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

  -- Use to_jsonb() to dynamically read 'title'/'label' + 'due_date'/'due'
  -- so missing legacy columns don't blow up the RPC.
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', t.id,
    'title', coalesce(to_jsonb(t)->>'title', to_jsonb(t)->>'label', '(task)'),
    'done', t.done,
    'due_date', coalesce(to_jsonb(t)->>'due_date', to_jsonb(t)->>'due'),
    'completed_by_partner_at', t.completed_by_partner_at
  ) order by t.done asc, t.created_at asc), '[]'::jsonb)
  into task_rows
  from public.tasks t
  where t.deal_id = deal_row.id and t.partner_visible = true;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', a.id,
    'action', a.action,
    'created_at', a.created_at,
    'author', coalesce(p.name, 'Team')
  ) order by a.created_at desc), '[]'::jsonb)
  into activity_rows
  from public.activity a
  left join public.profiles p on p.id = a.user_id
  where a.deal_id = deal_row.id
  order by a.created_at desc
  limit 30;

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

-- Same defensive fix for partner_complete_task — use to_jsonb to read
-- title/label without erroring if a column is missing.
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
  task_jsonb jsonb;
  task_label text;
begin
  if p_token is null or p_task_id is null then return false; end if;

  select * into access_row
  from public.partner_deal_access
  where token = p_token and enabled = true and revoked_at is null;
  if not found then return false; end if;

  select to_jsonb(t) into task_jsonb from public.tasks t
  where id = p_task_id and deal_id = access_row.deal_id and partner_visible = true;
  if task_jsonb is null then return false; end if;

  update public.tasks
  set done = p_done,
      completed_by_partner_at = case when p_done then now() else null end
  where id = p_task_id;

  task_label := coalesce(task_jsonb->>'title', task_jsonb->>'label', '(task)');

  insert into public.activity(deal_id, user_id, action)
  values (
    access_row.deal_id,
    null,
    coalesce(access_row.partner_name, 'Partner') ||
      case when p_done then ' marked task complete: ' else ' reopened task: ' end ||
      task_label
  );

  return true;
end;
$$;

grant execute on function public.partner_complete_task(uuid, uuid, boolean) to anon, authenticated;

-- Allow 'partner' as a valid tab value so user_deal_views upserts don't fail
-- silently when Nathan opens the JV tab.
alter table public.user_deal_views drop constraint if exists user_deal_views_tab_check;
alter table public.user_deal_views
  add constraint user_deal_views_tab_check
  check (tab in ('overview','comms','docket','contacts','investor','partner','expenses','tasks','files'));
