-- Lauren-goes-national (spec 2026-08-17): the state compliance matrix as a
-- table (Lauren consumes at runtime; sniper + bridge consume later), plus
-- spend-protection plumbing (§7).

create table if not exists public.state_compliance_matrix (
  state text primary key,
  tier text not null check (tier in ('GREEN','YELLOW','RED')),
  guidance text not null,
  note text,
  updated_at timestamptz not null default now()
);
alter table public.state_compliance_matrix enable row level security;
drop policy if exists state_matrix_read on public.state_compliance_matrix;
create policy state_matrix_read on public.state_compliance_matrix for select to authenticated using (true);

insert into public.state_compliance_matrix (state, tier, guidance, note) values
  ('OH','GREEN','Full help, capture, escalate. No fee figures.','Clerk-held surplus product; ORC 169.16 registration question open'),
  ('IN','GREEN','Full help, capture, escalate. No fee figures.','Clerk-held surplus; AG-held money capped 10%/$5k — different pool'),
  ('FL','YELLOW','Be warm. Capture the lead and escalate. Promise nothing beyond: someone will review your case and tell you honestly whether we can help. Do not state or imply that we can recover their funds.','HARD STOP: never suggest signing anything in FL — standard agreement void under Fla. Stat. 717.135(6); licensing likely required'),
  ('GA','YELLOW','Be warm. Capture the lead and escalate. Promise nothing beyond: someone will review your case and tell you honestly whether we can help. Do not state or imply that we can recover their funds.','Tax-sale excess only (non-judicial state); state-held capped 10% with 24-month bar')
on conflict (state) do update set tier = excluded.tier, guidance = excluded.guidance, note = excluded.note, updated_at = now();

insert into public.state_compliance_matrix (state, tier, guidance)
select s, 'YELLOW', 'Be warm. Capture the lead and escalate. Promise nothing beyond: someone will review your case and tell you honestly whether we can help. Do not state or imply that we can recover their funds.'
from unnest(array['AL','AK','AZ','AR','CA','CO','CT','DE','DC','HI','ID','IL','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY']) s
on conflict (state) do nothing;

create table if not exists public.lauren_usage (
  day date primary key,
  tokens bigint not null default 0,
  requests int not null default 0
);
alter table public.lauren_usage enable row level security;

create or replace function public.lauren_spend_bump(p_tokens bigint)
returns bigint language plpgsql security definer
set search_path = public, pg_catalog as $$
declare v_total bigint;
begin
  insert into lauren_usage (day, tokens, requests) values (current_date, greatest(p_tokens, 0), 1)
  on conflict (day) do update set tokens = lauren_usage.tokens + greatest(p_tokens, 0), requests = lauren_usage.requests + 1
  returning tokens into v_total;
  return v_total;
end $$;

alter table public.lauren_sessions add column if not exists tokens_used bigint not null default 0;
