-- 2026-05-09 — Auto-flip contacts.do_not_text / .do_not_call from notes phrases.
--
-- Why: Per session_archives/2026-05-08-audit-retraction-marathon.md, Eric
-- flagged Richard Mikol's three contact rows as "DND for SMS" in IDI Core
-- notes (free-text `contacts.notes` field), but the structured boolean
-- `contacts.do_not_text` stayed false. The auto-queue gate reads the
-- BOOLEAN, not notes — so Richard slipped past despite Eric's clear
-- notation, and we drafted SMS that should have been blocked.
--
-- Fix: a BEFORE INSERT/UPDATE trigger on contacts.notes that detects
-- DND-class phrases and flips the structured booleans (text + call
-- independently). One-shot backfill at the end re-runs the same logic
-- against existing rows so Richard's 3 contacts and any other historical
-- DND-in-notes cases close immediately.
--
-- Conservative posture: bare "DND" / "do not contact" / "do not disturb"
-- match BOTH text + call patterns, flagging both columns. False positives
-- on do_not_call are harmless today (no programmatic outbound calls);
-- false negatives on do_not_text would burn customers (auto-queue fires
-- SMS), so we err toward over-flagging.
--
-- Patterns matched (case-insensitive, word-boundary):
--   text  →  DND, do not (text|sms|message|contact|disturb),
--            no (text|sms|messag|texting), stop texting
--   call  →  DND, do not (call|phone|voice|contact|disturb),
--            no calls?, stop calling

-- ── 0. Defensively ensure columns exist ──────────────────────────────
-- The do_not_text/do_not_call/dnd_set_at/dnd_reason columns were added
-- via the dashboard SQL editor 2026-04-25 without a corresponding
-- migration file (per CLAUDE.md). Add IF NOT EXISTS clauses so this
-- migration is self-contained + idempotent in case a future env starts
-- from migrations alone.
alter table public.contacts
  add column if not exists do_not_text boolean default false;
alter table public.contacts
  add column if not exists do_not_call boolean default false;
alter table public.contacts
  add column if not exists dnd_set_at timestamptz;
alter table public.contacts
  add column if not exists dnd_reason text;

create or replace function public.sync_contact_dnd_from_notes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_text_dnd boolean := false;
  v_call_dnd boolean := false;
  v_reason   text;
begin
  -- No notes → nothing to detect; preserve existing flag values.
  if NEW.notes is null or btrim(NEW.notes) = '' then
    return NEW;
  end if;

  v_text_dnd := NEW.notes ~* '\m(DND|do\s*not\s*(text|sms|message|contact|disturb)|no\s*(text|sms|messag|texting)|stop\s*texting)\M';
  v_call_dnd := NEW.notes ~* '\m(DND|do\s*not\s*(call|phone|voice|contact|disturb)|no\s*calls?|stop\s*calling)\M';

  if not (v_text_dnd or v_call_dnd) then
    return NEW;
  end if;

  v_reason := 'auto-detected DND phrase in notes';

  if v_text_dnd and not coalesce(NEW.do_not_text, false) then
    NEW.do_not_text := true;
    NEW.dnd_set_at  := coalesce(NEW.dnd_set_at, now());
    NEW.dnd_reason  := coalesce(NEW.dnd_reason, v_reason);
  end if;

  if v_call_dnd and not coalesce(NEW.do_not_call, false) then
    NEW.do_not_call := true;
    NEW.dnd_set_at  := coalesce(NEW.dnd_set_at, now());
    NEW.dnd_reason  := coalesce(NEW.dnd_reason, v_reason);
  end if;

  return NEW;
end;
$$;

comment on function public.sync_contact_dnd_from_notes() is
  'BEFORE insert/update trigger on contacts.notes. Detects DND-class phrases (DND, "do not text/call/contact", "no text/call", "stop texting/calling") and sets do_not_text + do_not_call accordingly. Bare "DND" flips both. Conservative: never un-sets a true; only ever flips false→true with reason auto-stamped. Closes the Richard-Mikol-class leak documented 2026-05-08.';

drop trigger if exists tg_sync_contact_dnd_from_notes on public.contacts;
create trigger tg_sync_contact_dnd_from_notes
  before insert or update of notes on public.contacts
  for each row
  execute function public.sync_contact_dnd_from_notes();

-- ── Backfill ───────────────────────────────────────────────────────
-- Force the trigger to re-evaluate every existing row whose notes
-- contain any DND-shaped phrase. The `notes = notes` no-op write
-- guarantees the BEFORE UPDATE OF notes trigger fires for each row.
update public.contacts
set notes = notes
where notes is not null
  and notes ~* '\m(DND|do\s*not\s*(text|sms|message|call|phone|voice|contact|disturb)|no\s*(text|sms|texting|calls?|phone|voice)|stop\s*(text|call)ing)\M';

-- ── Verify ────────────────────────────────────────────────────────
-- Returns count of contacts that ended up DND-flagged after backfill.
select
  exists (select 1 from pg_proc where proname = 'sync_contact_dnd_from_notes') as fn_exists,
  exists (select 1 from pg_trigger where tgname = 'tg_sync_contact_dnd_from_notes') as trigger_attached,
  (select count(*) from public.contacts where do_not_text is true) as dnd_text_count,
  (select count(*) from public.contacts where do_not_call is true) as dnd_call_count,
  (select count(*) from public.contacts
     where do_not_text is true
       and dnd_reason ilike 'auto-detected%'
  ) as auto_detected_text_count,
  (select count(*) from public.contacts
     where name ilike '%mikol%' and do_not_text is true
  ) as mikol_now_dnd;
