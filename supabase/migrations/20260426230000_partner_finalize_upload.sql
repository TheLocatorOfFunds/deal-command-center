-- Two RPCs that let the JV partner upload large files (videos!) directly to
-- storage via signed PUT URLs, without going through the Edge Function body
-- limit. Flow:
--   1. Browser → partner_request_upload(token, name, size, mime)
--      RPC creates a 'pending' documents row + returns the storage path.
--      Browser then POSTs to /functions/v1/partner-upload-url with that path
--      to get a signed PUT URL (Edge Function uses service role to mint it).
--   2. Browser PUTs the file directly to the signed URL — fast, no size cap
--      beyond Supabase Storage's 5 GB ceiling.
--   3. Browser → partner_finalize_upload(token, document_id, final_size)
--      RPC marks the row complete, logs activity ("Kevin uploaded: foo.mp4").
--
-- Why split request/finalize: if the browser dies mid-PUT, the documents
-- row stays in pending state and Nathan can see something tried to upload
-- but failed. Cleanup is a periodic sweep, not built yet.
--
-- The existing multipart partner-upload Edge Function still works for
-- tiny photos (<5 MB-ish) — kept as a fallback path.

-- Track upload state on the documents row
alter table public.documents
  add column if not exists upload_state text not null default 'complete'
    check (upload_state in ('pending', 'complete', 'failed'));

create index if not exists idx_documents_pending_partner_uploads
  on public.documents(uploaded_by_partner_access_id, created_at desc)
  where upload_state = 'pending';

-- Step 1: partner asks for an upload slot. We create the documents row in
-- 'pending' state (so we can track failed uploads) and return the path
-- the browser should PUT to.
create or replace function public.partner_request_upload(
  p_token uuid,
  p_filename text,
  p_size bigint default null,
  p_mime text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  access_row public.partner_deal_access%rowtype;
  safe_name text;
  storage_path text;
  doc_id uuid;
begin
  if p_token is null or p_filename is null then return null; end if;
  if length(p_filename) > 200 then return null; end if;

  select * into access_row
  from public.partner_deal_access
  where token = p_token and enabled = true and revoked_at is null;
  if not found then return null; end if;

  -- Sanitize: keep alphanumeric + . _ -, cap at 120 chars, preserve extension
  safe_name := regexp_replace(p_filename, '[^a-zA-Z0-9._-]', '_', 'g');
  if length(safe_name) > 120 then safe_name := substring(safe_name from 1 for 120); end if;

  storage_path := access_row.deal_id || '/partner/' ||
    extract(epoch from now())::bigint || '-' || safe_name;

  insert into public.documents (
    deal_id, name, path, size,
    partner_visible, uploaded_by_partner_access_id, uploaded_by_partner_at,
    upload_state, extraction_status
  ) values (
    access_row.deal_id, safe_name, storage_path, coalesce(p_size, 0),
    true, access_row.id, now(),
    'pending', 'pending'
  ) returning id into doc_id;

  return jsonb_build_object(
    'document_id', doc_id,
    'path', storage_path,
    'safe_name', safe_name,
    'deal_id', access_row.deal_id
  );
end;
$$;

grant execute on function public.partner_request_upload(uuid, text, bigint, text) to anon, authenticated;

-- Step 3: partner says "I'm done PUTting the file" — flip the row to
-- complete + log activity. Also accepts a final_size in case the browser
-- knew the size only after picking the file.
create or replace function public.partner_finalize_upload(
  p_token uuid,
  p_document_id uuid,
  p_final_size bigint default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  access_row public.partner_deal_access%rowtype;
  doc_row public.documents%rowtype;
begin
  if p_token is null or p_document_id is null then return false; end if;

  select * into access_row
  from public.partner_deal_access
  where token = p_token and enabled = true and revoked_at is null;
  if not found then return false; end if;

  -- Confirm the doc row belongs to THIS partner's access row (no cross-token
  -- finalization) and is in pending state.
  select * into doc_row from public.documents
  where id = p_document_id
    and uploaded_by_partner_access_id = access_row.id
    and upload_state = 'pending';
  if not found then return false; end if;

  update public.documents
  set upload_state = 'complete',
      size = coalesce(p_final_size, size)
  where id = p_document_id;

  insert into public.activity(deal_id, user_id, action) values (
    access_row.deal_id, null,
    coalesce(access_row.partner_name, 'Partner') || ' uploaded: ' || doc_row.name
  );

  return true;
end;
$$;

grant execute on function public.partner_finalize_upload(uuid, uuid, bigint) to anon, authenticated;

-- Bonus: if the browser dies mid-PUT, partner can call this to mark a
-- pending row failed so it disappears from "in progress" UI.
create or replace function public.partner_abandon_upload(
  p_token uuid,
  p_document_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  access_row public.partner_deal_access%rowtype;
begin
  if p_token is null or p_document_id is null then return false; end if;

  select * into access_row
  from public.partner_deal_access
  where token = p_token and enabled = true and revoked_at is null;
  if not found then return false; end if;

  delete from public.documents
  where id = p_document_id
    and uploaded_by_partner_access_id = access_row.id
    and upload_state = 'pending';

  return true;
end;
$$;

grant execute on function public.partner_abandon_upload(uuid, uuid) to anon, authenticated;

-- Update get_partner_deal_by_token to skip pending uploads (so half-uploaded
-- files don't show as broken thumbnails to the partner).
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

  select * into access_row from public.partner_deal_access
  where token = p_token and enabled = true and revoked_at is null;
  if not found then return null; end if;

  select * into deal_row from public.deals where id = access_row.deal_id;
  if not found then return null; end if;

  update public.partner_deal_access
  set last_viewed_at = now(), view_count = view_count + 1
  where id = access_row.id;

  partner_meta := coalesce(deal_row.meta->'partner', '{}'::jsonb);

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', d.id, 'name', d.name, 'path', d.path, 'size', d.size,
    'created_at', d.created_at,
    'document_type', d.extracted->>'document_type',
    'is_cover', (d.path = (partner_meta->>'coverPhotoPath')),
    'is_image', (d.name ~* '\.(jpg|jpeg|png|webp|heic|gif)$'),
    'is_video', (d.name ~* '\.(mp4|mov|m4v|webm|avi|mkv)$')
  ) order by d.created_at asc), '[]'::jsonb)
  into docs from public.documents d
  where d.deal_id = deal_row.id
    and d.partner_visible = true
    and (d.upload_state = 'complete' or d.upload_state is null);  -- skip in-flight/failed

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
    'id', a.id, 'action', a.action, 'created_at', a.created_at,
    'author', coalesce(p.name, 'Team')
  ) order by a.created_at desc), '[]'::jsonb)
  into activity_rows
  from public.activity a
  left join public.profiles p on p.id = a.user_id
  where a.deal_id = deal_row.id;

  result := jsonb_build_object(
    'access_id', access_row.id,
    'partner_name', access_row.partner_name,
    'partner_email', access_row.partner_email,
    'partner_phone', access_row.partner_phone,
    'profit_share_pct', access_row.profit_share_pct,
    'role_description', access_row.role_description,
    'invited_at', access_row.invited_at,
    'deal', jsonb_build_object(
      'id', deal_row.id, 'name', deal_row.name,
      'headline_address', deal_row.address,
      'county', deal_row.meta->>'county',
      'type', deal_row.type, 'status', deal_row.status,
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
