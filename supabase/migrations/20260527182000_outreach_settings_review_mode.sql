-- Phase A.3 — review-mode flag (the "training wheels" toggle)
--
-- Per Justin 2026-05-27: during the testing phase, NOTHING sends without a
-- human reviewing it first. Coach + feedback on every text. At go-live we
-- flip one switch and the engines resume auto-send.
--
-- Two outbound paths currently auto-send with no human in the loop:
--   1. dispatch-cadence-message  — auto-sends Automations Day 1+ texts
--   2. relay-dispatcher (RVM)    — fires RVM drops directly (step 2 of every
--                                  seeded sequence). Relay SMS already routes
--                                  to outreach_queue for approval, so only the
--                                  RVM path needs gating.
--
-- Both EFs read this singleton flag (via service role, bypassing RLS). When
-- auto_send_enabled = false (the default, = testing), they HOLD instead of
-- sending: cadence rows stay 'pending' for human review in the queue, RVM
-- touches stay 'pending' to fire once auto-send is turned on.
--
-- Flip to live with:  update public.outreach_settings set auto_send_enabled = true where id = 1;
-- (or use the toggle in the Outreach view header — admin only)

create table if not exists public.outreach_settings (
  id                 int          primary key default 1 check (id = 1),  -- singleton
  auto_send_enabled  boolean      not null default false,
  updated_at         timestamptz  not null default now(),
  updated_by         uuid         references auth.users(id) on delete set null
);

insert into public.outreach_settings (id, auto_send_enabled)
  values (1, false)
  on conflict (id) do nothing;

create or replace function public.tg_outreach_settings_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end$$;

drop trigger if exists outreach_settings_touch on public.outreach_settings;
create trigger outreach_settings_touch
  before update on public.outreach_settings
  for each row execute function public.tg_outreach_settings_touch();

alter table public.outreach_settings enable row level security;

-- Admin: full control (flip the flag). VA: read-only (see the mode).
create policy outreach_settings_admin_all on public.outreach_settings
  for all using (public.is_admin()) with check (public.is_admin());
create policy outreach_settings_va_read on public.outreach_settings
  for select using (public.is_va());

grant select, update on public.outreach_settings to authenticated;
