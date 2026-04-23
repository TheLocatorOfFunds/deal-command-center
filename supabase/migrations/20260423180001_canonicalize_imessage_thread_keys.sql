-- Fix iMessage rows where thread_key is keyed to our own phone numbers instead of the contact's.
--
-- Root cause: early bridge versions set thread_key = deal:phone:<to_number> for both inbound
-- and outbound, meaning inbound rows (where to_number = Nathan's number) got the wrong key.
-- The canonical rule is: always key on the contact's number (the non-Nathan party).
--
-- Our numbers: +15135162306 (Nathan iPhone), +15139985440 (Twilio business line).

update public.messages_outbound
set thread_key = deal_id || ':phone:' ||
  case
    when from_number not in ('+15135162306', '+15139985440')
      then from_number
    when to_number not in ('+15135162306', '+15139985440')
      then to_number
    else substring(thread_key from position(':phone:' in thread_key) + 7)
  end
where channel = 'imessage'
  and deal_id  is not null
  and (
    thread_key like '%:phone:+15135162306'
    or thread_key like '%:phone:+15139985440'
  )
  and (
    from_number not in ('+15135162306', '+15139985440')
    or to_number  not in ('+15135162306', '+15139985440')
  );
