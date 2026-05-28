-- Dead-phone registry (#253).
--
-- Background: the call disposition modal (#244) lets the team mark a
-- destination number as 'disconnected'. PR #247 wired that to
-- contacts.phone_status so the send-sms + twilio-voice-outbound EFs
-- refuse the next attempt — but the bad number stayed glued to the
-- contact row. If someone later edits the contact and types the same
-- number back (or a different team member adds a fresh contact with
-- that number), nothing warns them.
--
-- This migration introduces a number-keyed registry. The save handler
-- in CallDispositionModal will:
--   1. INSERT (or UPSERT, bumping occurrence_count) into bad_phone_numbers
--   2. NULL contacts.phone (the registry is now the source of truth)
--   3. Keep contacts.phone_status='disconnected' so UI shows the
--      red "☎ (disconnected)" placeholder
--   4. Write a deal_notes row so the bad number shows up in the deal log
--
-- The RPC lookup_bad_phone() is the lookup the UI uses on every phone
-- input — debounced, returns the registry row (or null) so we can render
-- "⚠️ This number was marked disconnected on YYYY-MM-DD when calling
-- <contact name>. Add anyway?" before letting someone re-add it.

begin;

create table if not exists public.bad_phone_numbers (
  -- E.164 (e.g. +15551234567). Source of truth — UI normalises before
  -- writing/reading. We deliberately use the number itself as PK so
  -- INSERT ... ON CONFLICT (phone) DO UPDATE SET occurrence_count = +1
  -- is the natural "mark again" path.
  phone                       text          primary key,
  reason                      text          not null default 'disconnected'
    check (reason in ('disconnected', 'wrong_number', 'do_not_call')),
  first_marked_at             timestamptz   not null default now(),
  first_marked_by             uuid          references auth.users (id) on delete set null,
  -- Snapshot the deal + contact + name at time of first mark. We don't
  -- FK these so the registry survives even if the deal/contact is
  -- deleted later — the whole point is that the *number* is bad
  -- regardless of which deal/contact it was attached to.
  first_marked_deal_id        text,
  first_marked_contact_id     uuid,
  first_marked_contact_name   text,
  -- Free-form notes the team can add via "Add anyway" or a future
  -- registry-admin UI.
  notes                       text,
  -- Bumped each time the same number gets marked again (override
  -- "add anyway" → calls again → marked disconnected again).
  occurrence_count            integer       not null default 1,
  last_marked_at              timestamptz   not null default now()
);

comment on table  public.bad_phone_numbers is 'Number-keyed registry of phones marked disconnected/wrong/DNC via the call disposition modal. UI looks up against this on every phone input.';
comment on column public.bad_phone_numbers.phone is 'E.164 format, e.g. +15551234567';
comment on column public.bad_phone_numbers.occurrence_count is 'Bumped on each subsequent mark of the same number — signals "yes really, this is bad".';

-- Index for case-insensitive E.164 lookup is redundant — phone IS the PK.

-- ─────────────────────────────────────────────────────────────────────
-- RLS — admins + VAs read/write, attorneys + clients no access.
-- ─────────────────────────────────────────────────────────────────────
alter table public.bad_phone_numbers enable row level security;

create policy bad_phone_numbers_admin_all on public.bad_phone_numbers
  for all
  using (public.is_admin())
  with check (public.is_admin());

create policy bad_phone_numbers_va_read on public.bad_phone_numbers
  for select
  using (public.is_va());

create policy bad_phone_numbers_va_write on public.bad_phone_numbers
  for insert
  with check (public.is_va());

create policy bad_phone_numbers_va_update on public.bad_phone_numbers
  for update
  using (public.is_va())
  with check (public.is_va());

-- ─────────────────────────────────────────────────────────────────────
-- RPC — single-number lookup. SECURITY DEFINER so the phone-input
-- warning fires even before a contact/deal row exists in the new-
-- contact / new-deal flows. The function only returns the registry
-- row for the exact phone passed in — no enumeration.
-- ─────────────────────────────────────────────────────────────────────
create or replace function public.lookup_bad_phone(p_phone text)
returns table (
  phone                     text,
  reason                    text,
  first_marked_at           timestamptz,
  first_marked_contact_name text,
  first_marked_deal_id      text,
  occurrence_count          integer,
  last_marked_at            timestamptz,
  notes                     text
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select
    b.phone,
    b.reason,
    b.first_marked_at,
    b.first_marked_contact_name,
    b.first_marked_deal_id,
    b.occurrence_count,
    b.last_marked_at,
    b.notes
  from public.bad_phone_numbers b
  where b.phone = p_phone
    -- Only logged-in team members can hit this — defense in depth on
    -- top of the publishable-key + auth gate the EF / client already
    -- has. Clients + attorneys never need to look up bad numbers.
    and (public.is_admin() or public.is_va());
$$;

revoke all on function public.lookup_bad_phone(text) from public;
grant execute on function public.lookup_bad_phone(text) to authenticated;

comment on function public.lookup_bad_phone(text) is 'Returns the bad_phone_numbers row for an exact E.164 match, or no rows. Used by the phone-input warning in DCC.';

commit;
