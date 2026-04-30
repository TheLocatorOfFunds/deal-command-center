-- phone_intel — per-phone-number capability + probe queue.
--
-- Per Nathan 2026-04-30: before sending a text, we want to know whether
-- a number is iMessage-capable (route via iPhone bridge), SMS-only
-- (route via Twilio), or unreachable (landline / VoIP / disconnected).
--
-- Implementation: Mac Mini bridge probes via AppleScript by opening
-- Messages.app, addressing the number, and reading whether the
-- destination shows blue (iMessage) or green (SMS) — same color cue
-- you see on a real iPhone. Bridge polls this table for status='queued'
-- rows, runs the probe, writes back imessage_capable + line_type +
-- probed_at + status='done'.
--
-- Single row per phone_e164 — same number across multiple contacts
-- shares one probe result. UPSERT semantics so re-queueing a number
-- already in 'done' bumps requested_at + flips status back to 'queued'.

create table if not exists public.phone_intel (
  phone_e164 text primary key,                -- canonical +1XXXXXXXXXX
  imessage_capable boolean,                    -- true=blue, false=green, null=not yet known
  line_type text,                              -- 'mobile', 'landline', 'voip', 'unreachable', 'unknown'
  carrier text,                                -- optional, future
  probed_at timestamptz,
  probe_method text,                           -- 'mac_bridge', 'twilio_lookup', etc.
  probe_error text,                            -- when probe failed
  status text not null default 'queued'        -- 'queued', 'probing', 'done', 'failed'
    check (status in ('queued','probing','done','failed')),
  requested_at timestamptz not null default now(),
  requested_by uuid references auth.users(id),
  do_not_text boolean default false,           -- override; honored by send paths
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_phone_intel_status_requested on public.phone_intel(status, requested_at);
create index if not exists idx_phone_intel_imessage on public.phone_intel(imessage_capable);

create or replace function public.tg_phone_intel_updated_at()
returns trigger language plpgsql as $$
begin NEW.updated_at = now(); return NEW; end;
$$;
drop trigger if exists tg_phone_intel_updated_at on public.phone_intel;
create trigger tg_phone_intel_updated_at
  before update on public.phone_intel
  for each row execute function public.tg_phone_intel_updated_at();

alter table public.phone_intel enable row level security;

-- Team can read everything (same access as contacts table).
drop policy if exists "team can read phone_intel" on public.phone_intel;
create policy "team can read phone_intel"
  on public.phone_intel for select
  using (public.is_admin() or public.is_va());

-- Team can queue probes (insert + upsert).
drop policy if exists "team can queue phone_intel probes" on public.phone_intel;
create policy "team can queue phone_intel probes"
  on public.phone_intel for insert
  with check (public.is_admin() or public.is_va());

-- Team can update (re-queue, edit notes, set DND override).
drop policy if exists "team can update phone_intel" on public.phone_intel;
create policy "team can update phone_intel"
  on public.phone_intel for update
  using (public.is_admin() or public.is_va());

-- Convenience RPC: queue or re-queue a probe in one call.
-- Returns the row after upsert. Bridge consumes via SELECT WHERE status='queued'.
create or replace function public.queue_phone_probe(p_phone_e164 text)
returns public.phone_intel
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.phone_intel;
begin
  insert into public.phone_intel as pi (phone_e164, status, requested_at, requested_by)
  values (p_phone_e164, 'queued', now(), v_uid)
  on conflict (phone_e164) do update set
    status = 'queued',
    requested_at = now(),
    requested_by = v_uid,
    probe_error = null
  returning pi.* into v_row;
  return v_row;
end;
$$;

grant execute on function public.queue_phone_probe(text) to authenticated;

comment on table public.phone_intel is
  'Per-phone-number capability cache. Mac Mini bridge probes via Messages.app AppleScript and writes back imessage_capable/line_type. DCC reads to render UI tags + decide outbound routing (iPhone bridge vs Twilio).';
comment on column public.phone_intel.imessage_capable is
  'true=Apple bubble turned blue (iMessage), false=green (SMS-only), null=unknown / not yet probed.';
comment on column public.phone_intel.line_type is
  '''mobile''/''landline''/''voip''/''unreachable''/''unknown''. Apple''s probe distinguishes mobile (blue/green) from unreachable (Messages refuses); landline/voip detection requires a separate lookup.';
