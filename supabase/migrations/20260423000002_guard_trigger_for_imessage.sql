-- Group-chat leak fix: guard tg_route_message_to_deal so it never fires
-- on bridge-sourced iMessage rows.
--
-- Root cause: the bridge syncs every 1:1 chat from Nathan's chat.db and
-- the trigger auto-routes them to deals by phone-matching. For group chats
-- (now filtered at the bridge level) the trigger was the second wall that
-- stamped personal-chat messages with a deal_id.
--
-- Fix: if channel = 'imessage', return immediately — deal linking for bridge
-- rows is explicit (set by the bridge or by the triage UI), never inferred.

create or replace function tg_route_message_to_deal()
returns trigger language plpgsql security definer as $$
declare
  matched text;
  bare    text;
begin
  -- Never auto-route bridge-sourced iMessage rows.
  -- Those must be linked to deals explicitly (bridge sets deal_id directly,
  -- or the triage inbox lets an admin assign them).
  if new.channel = 'imessage' then
    return new;
  end if;

  if new.deal_id is not null then
    return new;
  end if;

  -- Try to_number (Twilio inbound: contact phone is in from_number,
  -- but we check to_number first for symmetry)
  if new.to_number is not null then
    bare := regexp_replace(new.to_number, '^\+?1', '');
    select id into matched from find_deal_by_phone(new.to_number, bare) limit 1;
  end if;

  -- Fallback: try from_number (Twilio inbound stores contact phone here)
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

-- The trigger itself doesn't change (same name, same timing) — only the
-- function body above changed. No DROP/CREATE needed for the trigger.
