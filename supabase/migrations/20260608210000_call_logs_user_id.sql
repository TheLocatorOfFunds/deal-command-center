-- 20260608210000_call_logs_user_id.sql
--
-- Per-agent attribution on call_logs. Both outbound and inbound today register
-- under the SHARED Twilio identity 'dcc-fundlocators' (see twilio-token), so
-- Twilio itself cannot tell Justin from Nathan from Eric. Attribution has to
-- come from the client at call time:
--
--   outbound: twilio-voice-outbound reads the userId param from the Voice SDK
--             connect() call and writes it into the call_logs insert.
--
--   inbound:  when an agent clicks Accept in the browser/mobile app, the client
--             calls claim_inbound_call(sid, user_id) to stamp itself on the
--             pre-existing inbound call_log row (created by twilio-voice in
--             'ringing' state).
--
-- Companion to the assignee-filter work shipped same day. Justin 2026-06-08.

alter table public.call_logs
  add column if not exists user_id uuid
  references public.profiles(id) on delete set null;

create index if not exists call_logs_user_id_started_at_idx
  on public.call_logs(user_id, started_at desc);

create or replace function public.claim_inbound_call(p_call_sid text, p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_count int;
begin
  -- Only allow a team member to claim a call as themselves.
  if auth.uid() is null or auth.uid() <> p_user_id then
    raise exception 'claim_inbound_call: must claim as yourself (auth.uid() does not match p_user_id)';
  end if;
  if not exists (
    select 1 from public.profiles
    where id = p_user_id
      and role in ('admin','user','va')
  ) then
    raise exception 'claim_inbound_call: only admin/user/va profiles can claim calls';
  end if;

  -- Stamp only if the row exists and has not already been claimed. This makes
  -- the RPC idempotent + race-safe across multiple agents who might click
  -- Accept simultaneously (whoever's UPDATE lands first wins; the others
  -- silently no-op).
  update public.call_logs
  set user_id = p_user_id
  where twilio_call_sid = p_call_sid
    and direction = 'inbound'
    and user_id is null;

  get diagnostics updated_count = row_count;
  return updated_count > 0;
end;
$$;

grant execute on function public.claim_inbound_call(text, uuid) to authenticated;

-- Reverse-lookup convenience: call_logs joins to profiles via user_id. Already
-- supported by PostgREST because the FK is declared above; no extra hint needed.
