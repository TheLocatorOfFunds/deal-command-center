---
name: comms-diagnose
description: Diagnose why a specific call, SMS, RVM, or email isn't surfacing in DCC — runs the full table chain (call_logs / messages_outbound / emails) + thread_key check + deal_id linkage. Use when Justin or Nathan says "I see the X but not the Y."
allowed-tools: mcp__supabase__execute_sql, mcp__supabase__list_edge_functions, Bash, Read
---

# Comms Diagnose

## When to invoke
- "I see the call/text/email in X but not in Y"
- "Why isn't the recording showing"
- "I sent it but the recipient says they didn't get it"
- Any user-visible comms surface gap

## Inputs needed
- Phone number OR call_sid OR thread_key OR deal_id
- The surface they're looking at ("Call History," "Comms tab,"
  "AUTOMATIONS," mobile thread, etc.)

## Diagnostic chain

### Step 1 — find the row(s)

For an inbound call investigation:
```sql
select id, deal_id, contact_id, direction, status,
       from_number, to_number,
       duration_seconds, recording_url, recording_sid, recording_duration,
       twilio_call_sid, started_at, ended_at, thread_key
from call_logs
where from_number like '%<last 7 digits>%' or to_number like '%<last 7 digits>%'
   or twilio_call_sid = '<sid if given>'
order by started_at desc limit 5;
```

For an SMS:
```sql
select id, deal_id, contact_id, direction, channel, status,
       from_number, to_number, body, twilio_sid, gateway_msg_id,
       thread_key, created_at, read_by_team_at, media_url
from messages_outbound
where (to_number like '%<digits>%' or from_number like '%<digits>%')
order by created_at desc limit 5;
```

### Step 2 — check linkage

Is the call/message linked to a deal/contact?

```sql
select 'contact match' as src, c.id::text, c.name, c.phone
from contacts c where c.phone like '%<digits>%'
union all
select 'deal_meta', d.id, d.name, d.meta->>'homeownerPhone'
from deals d
where d.meta->>'homeownerPhone' like '%<digits>%'
   or d.meta->>'phone' like '%<digits>%';
```

If `deal_id` is null → orphan. Cold inbound from unknown number; will
NOT surface on any deal-scoped view. Refer to #226 (orphan handling
spec) — currently no UI affordance to link.

### Step 3 — check the surface's actual query

The DCC has 3 distinct call surfaces, each with its own query:

| Surface | Reads | Scope | Notes |
|---|---|---|---|
| Global `CallHistoryView` (sidebar Calls view) | `call_logs` | All deals + orphans | Does NOT select `recording_url`. Recordings never render here. See #226. |
| Per-deal `CallRecordings` player | `call_recordings` (wrong) | `eq deal_id` | Reads empty table — bug. Should read `call_logs`. See #226. |
| Attention/Inbox feed | `call_logs` | `.in('deal_id', ids)` only | Filters by active deals; orphans hidden. |

For SMS, the surfaces split similarly:
- Per-deal Comms tab (deal-scoped `messages_outbound`)
- Reply Inbox (cross-deal unread inbound)
- Mobile `thread/[key].tsx` (thread_key scoped)

### Step 4 — check the EF path

If the row exists but isn't there: rendering bug.
If the row doesn't exist: ingestion bug.

For ingestion bugs:
```
mcp__supabase__get_logs service=edge-function
```

Check the relevant EF version + recent invocations:
- inbound SMS → `receive-sms`
- inbound call status → `twilio-voice-status`
- inbound call → `twilio-voice`
- RVM callback → `slybroadcast-callback`
- inbound iMessage via bridge → check `mac-bridge` log: `ssh defender-mini "tail -50 /tmp/dcc-bridge.log"`

### Step 5 — report

Format:
- **Captured:** yes/no — with row id + key fields
- **Linked:** yes/no to which deal/contact
- **Surface bug:** which component's query is the gap
- **Fix path:** patch suggestion OR reference to the relevant open issue

## Real examples this skill is for

- 2026-05-26: 740-591-6262 inbound call, 230s answered, recording
  captured in `call_logs` (sid RE157cf2d10efdfede21f7bdb531843a71),
  but `CallHistoryView.select()` omits `recording_url` → not visible.
  Diagnosed in ~10 messages without skill; will be ~2 with skill.

- 2026-05-13: inbound MMS attachments dropping. Diagnosed via this
  same chain (`receive-sms` not reading `NumMedia`).

## Anti-patterns

- Don't guess. Query first, theorize second.
- Don't fix code while comms reorg is in flight — diagnose, document,
  defer the code change to whichever rebuild session owns the surface.
