---
name: twilio-route-check
description: Given a phone number, return everything DCC knows about it — contact link, deal link, line type, opt-out state, recent comms history, gateway routing decision. Use before any outbound test send, or when investigating a delivery failure.
allowed-tools: mcp__supabase__execute_sql, Bash
---

# Twilio Route Check

## When to invoke
- Before sending a test SMS / call / RVM (verify it's a test number, not a real lead)
- When a delivery callback fails
- When Justin asks "what do we know about this number"
- During DND / opt-out investigation

## Input
Phone number in any format. Normalize internally to E.164:
- 10 digits → prepend `+1`
- 11 digits starting with `1` → prepend `+`
- Already `+1...` → leave

## The query

```sql
with target as (
  select '+1<10-digit>' as phone, '<last-7>' as last7
)
select
  -- Contact link
  (select json_agg(c.*) from contacts c, target t
   where c.phone like '%'||t.last7||'%') as contacts,
  -- Deal links via contacts
  (select json_agg(jsonb_build_object('deal_id', cd.deal_id, 'rel', cd.relationship))
   from contact_deals cd join contacts c on c.id = cd.contact_id, target t
   where c.phone like '%'||t.last7||'%') as deal_links,
  -- Direct deal meta match
  (select json_agg(jsonb_build_object('deal_id', d.id, 'name', d.name, 'status', d.status))
   from deals d, target t
   where d.meta->>'homeownerPhone' like '%'||t.last7||'%'
      or d.meta->>'phone' like '%'||t.last7||'%') as deals_via_meta,
  -- Phone intel
  (select to_jsonb(pi.*) from phone_intel pi, target t
   where pi.phone_e164 = t.phone) as intel,
  -- Recent SMS (last 30d)
  (select count(*) from messages_outbound mo, target t
   where (mo.to_number like '%'||t.last7||'%' or mo.from_number like '%'||t.last7||'%')
     and mo.created_at > now() - interval '30 days') as sms_30d,
  -- Recent calls
  (select count(*) from call_logs cl, target t
   where (cl.from_number like '%'||t.last7||'%' or cl.to_number like '%'||t.last7||'%')
     and cl.started_at > now() - interval '30 days') as calls_30d,
  -- Last inbound time
  (select max(created_at) from messages_outbound mo, target t
   where mo.direction = 'inbound'
     and (mo.from_number like '%'||t.last7||'%')) as last_inbound_at;
```

## Decision logic (report this back)

### Send / don't send
- If `contacts.do_not_text = true` OR `phone_intel.quality in ('bad','disconnected','wrong_number')` → **DO NOT SEND**
- If linked contact has `deceased = true` OR linked deal has `meta.deceased = 'true'` → **DO NOT SEND**
- If `phone_intel.line_type = 'landline'` for SMS → **WARN** (won't deliver)
- If `phone_intel.line_type = 'unreachable'` → **DO NOT SEND**

### Routing
- If `phone_numbers.gateway = 'twilio'` is the active outbound default → SMS sends via Twilio 5440
- If `imessage_capable = true` AND `gateway = 'mac_bridge'` chosen → bridge sends iMessage from Nathan's iPhone
- If `imessage_capable = false` AND bridge selected → **WARN**, bridge silently fails on Android (see `memory/messaging_bridge_imessage_only.md`)

### Test-send allowlist
Only these E.164 numbers are safe for test sends:
- `+14797196859` (Justin's cell)
- Nathan's confirmed test number (ask if uncertain)

Any other number → confirm with Justin before firing.

## Report format

```
Number: +1XXX-XXX-XXXX
├─ Contact: <name> (id: <uuid>) | NONE
├─ Linked deals: <id1, id2> | NONE
├─ Intel: line_type=<x>, carrier=<y>, imessage=<bool>, quality=<z>
├─ DND: do_not_text=<bool>, do_not_call=<bool>, reason=<>
├─ Activity 30d: <n> SMS, <m> calls
├─ Last inbound: <timestamp> | never
└─ Routing recommendation: <gateway> | DO NOT SEND because <reason>
```

## Anti-patterns

- Don't run a send just because the row "looks fine" — explicitly
  evaluate ALL gates (do_not_text, deceased, quality, line_type)
- Don't assume a number is in contacts just because it's been texted
  before (orphan calls/texts exist; see #226)
- Don't bypass the test-send allowlist even "just this once"
