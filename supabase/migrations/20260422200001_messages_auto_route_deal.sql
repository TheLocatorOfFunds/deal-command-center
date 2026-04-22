-- Expand find_deal_by_phone to check vendors + contacts in addition to homeownerPhone.
-- Priority: homeownerPhone first (most specific), then per-deal vendors, then company-wide contacts.
-- Normalizes both sides to last-10 digits so formats like "(813) 531-2211" match "+18135312211".
create or replace function find_deal_by_phone(phone_e164 text, phone_bare text)
returns table(id text) language sql security definer as $$
  select id from (
    -- 1. homeowner phone stored on the deal
    select d.id, 1 as priority
    from deals d
    where d.meta->>'homeownerPhone' is not null
      and right(regexp_replace(d.meta->>'homeownerPhone', '\D', '', 'g'), 10) = right(phone_bare, 10)

    union all

    -- 2. per-deal vendor/contractor phone
    select v.deal_id, 2 as priority
    from vendors v
    where v.phone is not null
      and right(regexp_replace(v.phone, '\D', '', 'g'), 10) = right(phone_bare, 10)

    union all

    -- 3. company-wide contact linked to a deal via contact_deals
    select cd.deal_id, 3 as priority
    from contacts c
    join contact_deals cd on cd.contact_id = c.id
    where c.phone is not null
      and right(regexp_replace(c.phone, '\D', '', 'g'), 10) = right(phone_bare, 10)
  ) matches
  order by priority
  limit 1;
$$;

-- Trigger function: on INSERT, fill deal_id if not already set.
-- Tries to_number first (iMessage bridge stores contact phone there for both directions),
-- then from_number (Twilio inbound stores contact phone there).
create or replace function tg_route_message_to_deal()
returns trigger language plpgsql security definer as $$
declare
  matched text;
  bare    text;
begin
  if new.deal_id is not null then
    return new;
  end if;

  -- Try to_number
  if new.to_number is not null then
    bare := regexp_replace(new.to_number, '^\+?1', '');
    select id into matched from find_deal_by_phone(new.to_number, bare) limit 1;
  end if;

  -- Fallback: try from_number (Twilio inbound)
  if matched is null and new.from_number is not null then
    bare := regexp_replace(new.from_number, '^\+?1', '');
    select id into matched from find_deal_by_phone(new.from_number, bare) limit 1;
  end if;

  if matched is not null then
    new.deal_id := matched;
  end if;

  return new;
end;
$$;

create trigger route_message_to_deal
  before insert on public.messages_outbound
  for each row execute function tg_route_message_to_deal();

-- Backfill: route existing null-deal_id rows where possible.
-- Runs once at migration time; no-op after that.
update public.messages_outbound m
set deal_id = sub.id
from (
  select
    msg.id as msg_id,
    coalesce(
      (select id from find_deal_by_phone(
        msg.to_number,
        regexp_replace(msg.to_number, '^\+?1', '')
      ) limit 1),
      (select id from find_deal_by_phone(
        msg.from_number,
        regexp_replace(coalesce(msg.from_number, ''), '^\+?1', '')
      ) limit 1)
    ) as id
  from messages_outbound msg
  where msg.deal_id is null
) sub
where m.id = sub.msg_id
  and sub.id is not null;
