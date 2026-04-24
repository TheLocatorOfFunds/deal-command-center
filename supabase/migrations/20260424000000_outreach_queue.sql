-- ═══════════════════════════════════════════════════════════════════════════
-- outreach_queue — human-in-the-loop AI outreach buffer
--
-- Flow:
--   pg_cron detects new A-leads → inserts status='queued' rows
--   DCC Today view picks up 'queued' rows → calls generate-outreach edge fn
--   Edge fn calls Claude, writes draft → status='pending'
--   Nathan sees approval card: coach AI → regenerate, edit, send, or skip
--   On Send: calls send-sms (mac_bridge → Nathan's iPhone number), → status='sent'
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.outreach_queue (
  id               uuid        primary key default gen_random_uuid(),
  deal_id          text        not null references public.deals(id) on delete cascade,
  contact_phone    text        not null,
  cadence_day      int         not null default 0,   -- 0=intro, 3=day3, 7=day7

  -- AI draft (current version)
  draft_body       text,
  agent_reasoning  text,
  draft_version    int         not null default 1,

  -- Human coaching input (fed into next AI generation)
  coach_note       text,

  -- Full history of draft → coach → redraft cycles (jsonb array)
  -- Each entry: { version, body, reasoning, coach_note, ts }
  draft_history    jsonb       not null default '[]'::jsonb,

  -- Status lifecycle
  status           text        not null default 'queued'
    check (status in ('queued', 'generating', 'pending', 'sent', 'skipped', 'failed')),

  -- When this item should surface for approval
  scheduled_for    timestamptz not null default now(),

  -- Result tracking
  message_id       uuid        references public.messages_outbound(id),
  sent_at          timestamptz,
  approved_by      uuid        references auth.users(id),
  skipped_reason   text,
  error_message    text,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

alter table public.outreach_queue enable row level security;
create policy "auth_all_outreach_queue" on public.outreach_queue
  for all to authenticated using (true) with check (true);

-- Fast lookup: actionable items for Today view
create index if not exists idx_outreach_queue_actionable
  on public.outreach_queue (status, scheduled_for)
  where status in ('queued', 'generating', 'pending');

-- Per-deal cadence lookup
create index if not exists idx_outreach_queue_deal_cadence
  on public.outreach_queue (deal_id, cadence_day);

-- Prevent duplicate active entries for same deal + cadence day
-- (terminal statuses sent/skipped/failed are excluded so retries are allowed)
create unique index if not exists idx_outreach_queue_no_dup_active
  on public.outreach_queue (deal_id, cadence_day)
  where status in ('queued', 'generating', 'pending');

-- Auto-update updated_at
create trigger outreach_queue_updated_at
  before update on public.outreach_queue
  for each row execute function public.set_updated_at();


-- ═══ pg_cron: detect new A-leads and queue intro outreach ═══════════════
-- Runs every 60 seconds.
-- Inserts a 'queued' row for any A-tier deal that:
--   1. Has sales_stage = 'new' (hasn't been texted yet)
--   2. Has a homeownerPhone in meta
--   3. Has no existing outreach_queue entry for cadence_day=0
--
-- The DCC Today view picks up 'queued' rows and calls generate-outreach
-- to get an AI draft. Nathan sees the draft and approves/edits/skips.

select cron.schedule(
  'queue-a-lead-intro-outreach',
  '* * * * *',
  $$
  insert into public.outreach_queue (deal_id, contact_phone, cadence_day, status, scheduled_for)
  select
    d.id,
    d.meta->>'homeownerPhone',
    0,
    'queued',
    now()
  from public.deals d
  where d.lead_tier = 'A'
    and d.sales_stage = 'new'
    and (d.meta->>'homeownerPhone') is not null
    and (d.meta->>'homeownerPhone') != ''
    and not exists (
      select 1 from public.outreach_queue q
      where q.deal_id = d.id
        and q.cadence_day = 0
    )
  $$
);
