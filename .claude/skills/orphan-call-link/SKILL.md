---
name: orphan-call-link
description: For a call_logs row with deal_id=null, surface candidate deals/contacts and (with confirmation) backfill the association so the number threads correctly going forward. Will be wired into DCC UI once #226 ships; this skill is the manual stopgap.
allowed-tools: mcp__supabase__execute_sql, Bash
disable-model-invocation: true
---

# Orphan Call Link

**Status:** Manual stopgap until the UI affordance in #226 ships. Mutates
`call_logs`, `contacts`, `contact_deals`. Side-effectful — explicit
`/orphan-call-link` invocation only.

## When to invoke
- An orphan call surfaces in Call History (`deal_id` null, no
  contact match)
- Justin says "link this call to the X deal" or "associate this
  number"

## Input
- `call_logs.id` (uuid) OR Twilio Call SID

## Steps

### 1. Load the orphan row

```sql
select id, from_number, to_number, direction, started_at,
       duration_seconds, recording_url, transcript
from call_logs
where id = '<input>' or twilio_call_sid = '<input>';
```

If `deal_id` is already set → not an orphan. Stop and report.

### 2. Surface candidate deals/contacts

Three signals, ranked:

1. **Recent comms with same number** — any prior SMS / call from this
   number that DID get linked (suggests the contact exists, this call
   just missed the matching trigger)
   ```sql
   select deal_id, max(created_at) from messages_outbound
   where to_number like '%<last7>%' or from_number like '%<last7>%'
   group by deal_id order by max(created_at) desc limit 5;
   ```

2. **Area-code / county heuristic** — match the area code to active
   deal counties (Ohio = 216/330/419/440/513/567/614/740/...)

3. **Voicemail transcript / Vapi voice_intake** — if there's a
   transcript or `voice_intake` (case number, address mentioned),
   grep `deals.meta` for matches
   ```sql
   select id, name, status from deals
   where meta->>'caseNumber' ilike '%<extracted>%'
      or address ilike '%<extracted>%';
   ```

### 3. Confirm with Justin

Present the candidates ranked, plus a "none of these — create new lead"
option. Wait for explicit pick.

### 4. Apply the linkage (transaction)

Once Justin picks a deal:

```sql
begin;
-- a) Find or create the contact
with up as (
  insert into contacts (name, phone, kind, owner_id)
  values (
    coalesce('<entered name>', 'Unknown caller ' || right('<phone>', 4)),
    '<phone_e164>',
    'homeowner',  -- or other based on context
    (select auth.uid())
  )
  on conflict (phone) do update set updated_at = now()
  returning id
)
-- b) Link contact to deal (idempotent)
insert into contact_deals (contact_id, deal_id, relationship)
select id, '<deal_id>', '<rel>' from up
on conflict (contact_id, deal_id) do nothing;

-- c) Backfill the call_logs row
update call_logs
set deal_id = '<deal_id>',
    contact_id = (select id from contacts where phone = '<phone_e164>'),
    thread_key = '<deal_id>:phone:<phone_e164>'
where id = '<call_id>';

-- d) Backfill any sibling messages_outbound rows
update messages_outbound
set deal_id = '<deal_id>',
    contact_id = (select id from contacts where phone = '<phone_e164>'),
    thread_key = '<deal_id>:phone:<phone_e164>'
where (to_number like '%<last7>%' or from_number like '%<last7>%')
  and deal_id is null;

commit;
```

### 5. Verify + report

```sql
select 'linked_call' as row, id::text from call_logs where id = '<call_id>'
union all
select 'linked_messages', count(*)::text from messages_outbound
where deal_id = '<deal_id>' and (to_number like '%<last7>%' or from_number like '%<last7>%');
```

Confirm to Justin: "Linked call <id> + N prior messages to deal <name>.
Future calls/texts from <phone> will thread into <deal_id>:phone:<phone>."

## Side effects to surface
- Creates/updates a `contacts` row (if no match)
- Adds a `contact_deals` link
- Mutates `call_logs.deal_id`, `contact_id`, `thread_key`
- Mutates prior `messages_outbound` rows that share the number

## Anti-patterns
- Don't run without explicit confirmation per orphan
- Don't auto-pick the top candidate — present all and wait
- Don't create a duplicate contact if a near-match exists (same area
  code + similar name pattern); flag for Justin
- Don't fire if #226 has shipped the in-app affordance — defer to UI

## Reverse / undo
```sql
update call_logs set deal_id = null, contact_id = null, thread_key = null
where id = '<call_id>';
delete from contact_deals where contact_id = '<id>' and deal_id = '<deal_id>';
```
