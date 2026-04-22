-- Tighten messages RLS: clients should only see messages tagged for them
-- (audience includes 'client'), attorneys only messages tagged for them
-- (audience includes 'attorney'). Before this patch, any role on an
-- assigned deal could read every message on that deal regardless of
-- audience — a cross-visibility leak.

drop policy if exists attorney_read_messages on public.messages;
create policy attorney_read_messages on public.messages
  for select to authenticated
  using (
    public.is_attorney()
    and deal_id in (
      select deal_id from public.attorney_assignments
      where user_id = auth.uid() and enabled = true
    )
    and (
      'attorney' = ANY(coalesce(audience, array['client']::text[]))
      or sender_id = auth.uid()
    )
  );

drop policy if exists client_read_messages on public.messages;
create policy client_read_messages on public.messages
  for select to authenticated
  using (
    public.is_client()
    and deal_id in (
      select deal_id from public.client_access
      where user_id = auth.uid() and enabled = true
    )
    and (
      'client' = ANY(coalesce(audience, array['client']::text[]))
      or sender_id = auth.uid()
    )
  );

-- When the attorney writes from their portal, default the audience to
-- ['attorney'] so the message stays in the Team ↔ Attorney private thread
-- unless the attorney explicitly adds 'client'. The existing INSERT
-- policies allow the write; this trigger just sets a sane default before
-- the row lands.
create or replace function public.stamp_message_audience_default()
returns trigger
language plpgsql
as $$
begin
  if NEW.audience is null or array_length(NEW.audience, 1) is null then
    if NEW.sender_role = 'attorney' then
      NEW.audience := array['attorney']::text[];
    elsif NEW.sender_role = 'client' then
      NEW.audience := array['client']::text[];
    else
      NEW.audience := array['client']::text[];
    end if;
  end if;
  return NEW;
end;
$$;

drop trigger if exists tg_stamp_message_audience_default on public.messages;
create trigger tg_stamp_message_audience_default
  before insert on public.messages
  for each row
  execute function public.stamp_message_audience_default();

comment on trigger tg_stamp_message_audience_default on public.messages is
  'Sets sensible audience default per sender role if none provided. Attorney -> [attorney] (private). Client -> [client]. Team fallback -> [client].';
