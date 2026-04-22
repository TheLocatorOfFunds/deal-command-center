-- ═══ Structured activity logging ══════════════════════════════════
-- Adds typed fields + an RPC so Eric can log a call/note/text/email
-- with outcome + optional follow-up that auto-creates a task.
-- The tg_bump_last_contacted trigger fires off of the `action` prefix
-- so call_verbs stay consistent for staleness rollup.
alter table public.activity
  add column if not exists activity_type text
    check (activity_type in ('call', 'note', 'text', 'sms', 'email', 'meeting', 'stage-change', 'system') or activity_type is null),
  add column if not exists outcome text,
  add column if not exists next_followup_date date,
  add column if not exists body text;

create or replace function public.log_deal_activity(
  p_deal_id text,
  p_type text,
  p_outcome text default null,
  p_body text default null,
  p_next_followup_date date default null,
  p_next_followup_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_id uuid;
  verb text;
  action_str text;
  user_name text;
begin
  if p_deal_id is null then raise exception 'deal_id required'; end if;
  if p_type is null then raise exception 'type required'; end if;

  verb := case lower(p_type)
    when 'call'   then 'Called'
    when 'text'   then 'Texted'
    when 'sms'    then 'Texted'
    when 'email'  then 'Emailed'
    when 'note'   then 'Note'
    when 'meeting' then 'Met with'
    else initcap(p_type)
  end;

  action_str := verb
    || case when p_outcome is not null and p_outcome != '' then ' (' || p_outcome || ')' else '' end
    || case when p_body is not null and p_body != '' then ' — ' || left(p_body, 220) else '' end;

  insert into public.activity (deal_id, user_id, action, activity_type, outcome, body, next_followup_date, visibility)
  values (p_deal_id, auth.uid(), action_str, lower(p_type), p_outcome, p_body, p_next_followup_date, array['team'])
  returning id into new_id;

  if p_next_followup_date is not null then
    select name into user_name from public.profiles where id = auth.uid();
    insert into public.tasks (deal_id, title, due_date, assigned_to)
    values (
      p_deal_id,
      'Follow up'
        || case when p_next_followup_note is not null and p_next_followup_note != '' then ': ' || p_next_followup_note else '' end,
      p_next_followup_date,
      coalesce(user_name, 'Nathan')
    );
  end if;

  return new_id;
end;
$$;

grant execute on function public.log_deal_activity(text, text, text, text, date, text) to authenticated;

-- ═══ SMS templates ═══════════════════════════════════════════════════
create table if not exists public.sms_templates (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  tier text not null check (tier in ('A', 'B', 'C', '30DTS', 'any')),
  body_template text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);

create index if not exists idx_sms_templates_tier on public.sms_templates(tier) where active = true;

alter table public.sms_templates enable row level security;

drop policy if exists admin_all_sms_templates on public.sms_templates;
create policy admin_all_sms_templates on public.sms_templates
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists va_use_sms_templates on public.sms_templates;
create policy va_use_sms_templates on public.sms_templates
  for select to authenticated using (public.is_va());

drop policy if exists va_edit_sms_templates on public.sms_templates;
create policy va_edit_sms_templates on public.sms_templates
  for update to authenticated using (public.is_va()) with check (public.is_va());

insert into public.sms_templates (label, tier, body_template) values
(
  'Tier A intro (alive, $100k+)', 'A',
E'Hi [FirstName], this is Lauren with RefundLocators.com. We''re an Ohio-based company that monitors every foreclosure in the state — we do full audits at no charge and only get paid if we actually recover money for you.\n\nWe reviewed your situation and wanted to reach out. This link takes you to your personal portal where you can see the surplus funds the county may be holding in your name, your case timeline, and what the recovery process looks like:\n\nhttps://refundlocators.com/s/[token]\n\nAny questions, just reply here. No pressure at all.\n\n— Lauren, RefundLocators.com'
),
(
  'Tier C intro (alive, $10k-$99k)', 'C',
E'Hi [FirstName], this is Lauren with RefundLocators.com. We''re an Ohio-based company that monitors every foreclosure in the state — we do full audits at no charge and only get paid if we actually recover money for you.\n\nWe reviewed your situation and wanted to reach out. This link takes you to your personal portal where you can see the surplus funds the county may be holding in your name, your case timeline, and what the recovery process looks like:\n\nhttps://refundlocators.com/s/[token]\n\nAny questions, just reply here. No pressure at all.\n\n— Lauren, RefundLocators.com'
),
(
  'Tier B intro (estate/heirs)', 'B',
E'Hi [FirstName], this is Lauren with RefundLocators.com. We''re an Ohio-based company that monitors foreclosures across the state. We came across a property that belonged to [OwnerName] and wanted to make sure the family is aware there may be surplus funds the county is holding.\n\nThis link is a personal portal with the details:\n\nhttps://refundlocators.com/s/[token]\n\nWe work on contingency — no cost unless funds are recovered. Just reply if you have questions.\n\n— Lauren, RefundLocators.com'
),
(
  '30DTS urgent (auction approaching)', '30DTS',
E'Hi [FirstName], this is Lauren with RefundLocators.com — we''re an Ohio company that tracks all sheriff sales. Your property has an auction coming up on [sale_date]. There may still be options, and if the sale does go through, the county may owe surplus funds afterward.\n\nThis link has your full timeline and what to expect:\n\nhttps://refundlocators.com/s/[token]\n\nReply anytime, we''re here to help.\n\n— Lauren, RefundLocators.com'
)
on conflict do nothing;

-- ═══ refundlocators.com personalized-link token ═══════════════════════
alter table public.deals
  add column if not exists refundlocators_token uuid;

create index if not exists idx_deals_refundlocators_token
  on public.deals(refundlocators_token)
  where refundlocators_token is not null;

comment on column public.deals.refundlocators_token is
  'Token generated by Castle for the /s/[token] personalized landing page on refundlocators.com. DCC reads this to inject into SMS templates.';
comment on function public.log_deal_activity(text, text, text, text, date, text) is
  'Structured activity logger. Writes one activity row with typed fields + optionally creates a follow-up task on a future date. The action prefix (Called/Texted/Emailed/Note) is what tg_bump_last_contacted watches for staleness bumps.';
