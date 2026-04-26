# QA — Monday-launch outreach pipeline (end-to-end smoke test)

**For:** any Claude QA agent with Supabase Management API access (PAT) and optionally Claude-in-Chrome MCP for UI testing.
**Repo:** `~/Documents/Claude/deal-command-center` · **Project:** `rcfaashkfpurkvtmsmeb`
**Built:** 2026-04-25 · last commit at QA time should be `d3a02c0` or newer
**Scope:** verify the cross-stack outreach pipeline is production-ready before Monday morning's A/B-tier blast.

## What was built (so you know what to test)

The system Nathan plans to use Monday morning:

```
1. Castle scores leads A/B/C (already live)
2. Castle creates personalized_links (token-based URLs at refundlocators.com/s/<token>)
3. Castle promotes link → DCC deal (manual or via Castle workflow)
4. Nathan opens Pipeline view → clicks "🚀 Queue outreach · N A/B" button
5. outreach_queue rows inserted (cadence_day=0, status='queued')
6. AutomationsQueue auto-fires generate-outreach for each
7. generate-outreach drafts SMS body using deals.refundlocators_token (auto-synced from personalized_links via tg_sync_refundlocators_token trigger)
8. Drafts surface in Outreach view (top-level nav) → Nathan reviews + clicks Send
9. send-sms fires → Twilio → claimant's phone
10. dispatch-cadence-message inserts next cadence_day row scheduled +N days
11. pg_cron 'outreach-cadence' fires every 15 min → walks queue → dispatches due drips
12. Cadence ladder: Day 0 (gated) → 1 → 3 → 5 → 12, 19, 26... → 90 → drop
13. On STOP/UNSUBSCRIBE inbound: receive-sms sets contacts.do_not_text=true + do_not_call=true, cancels future cadence rows, logs activity
14. send-sms refuses to send to do_not_text contacts (returns 403)
15. Inbound replies surface in Reply Inbox in Outreach view (cross-deal)
```

## Setup (one-time)

Get the Supabase PAT from `~/Library/Application Support/Claude/claude_desktop_config.json` `mcpServers.supabase-dcc.env.SUPABASE_ACCESS_TOKEN`. Or read it from there:
```bash
PAT=$(jq -r '.mcpServers["supabase-dcc"].env.SUPABASE_ACCESS_TOKEN' ~/Library/Application\ Support/Claude/claude_desktop_config.json)
PROJ="rcfaashkfpurkvtmsmeb"
```

Helper for SQL queries:
```bash
sql() { curl -sS -X POST "https://api.supabase.com/v1/projects/$PROJ/database/query" \
  -H "Authorization: Bearer $PAT" -H "Content-Type: application/json" \
  -d "$(jq -nc --arg q "$1" '{query:$q}')"; }
```

## Test plan

### T1 — Schema integrity (~30 sec)

**Verify:**
```bash
sql "select table_name, column_name from information_schema.columns where (table_name = 'messages_outbound' and column_name = 'read_by_team_at') or (table_name = 'contacts' and column_name in ('do_not_text', 'do_not_call', 'dnd_set_at', 'dnd_reason')) or (table_name = 'deals' and column_name = 'refundlocators_token') order by table_name, column_name"
```

**Pass criteria:** 6 rows returned. All five DND/inbox columns present + `deals.refundlocators_token`.

```bash
sql "select pg_get_constraintdef(oid) from pg_constraint where conname = 'outreach_queue_status_check'"
```

**Pass criteria:** check def includes `'cancelled'` in the allowed values.

### T2 — Trigger + cron presence (~30 sec)

```bash
sql "select tgname, proname from pg_trigger t join pg_proc p on p.oid = t.tgfoid where tgname in ('tg_sync_refundlocators_token', 'tg_notify_personalized_claim_submitted')"
sql "select jobname, schedule, active from cron.job where jobname in ('outreach-cadence', 'castle-health-daily')"
```

**Pass criteria:** Both triggers present; both cron jobs `active=true`.

### T3 — Edge Functions deployed (~10 sec)

```bash
curl -sS "https://api.supabase.com/v1/projects/$PROJ/functions" -H "Authorization: Bearer $PAT" | jq '.[] | select(.slug | IN("dispatch-cadence-message","receive-sms","send-sms","generate-outreach","castle-health-daily","notify-claim-submitted")) | {slug, version, status}'
```

**Pass criteria:** all 6 functions present, status=`ACTIVE`, `verify_jwt=false` (none required JWT). receive-sms version ≥ 12, send-sms version ≥ 18.

### T4 — Vault secrets present (~10 sec)

```bash
sql "select name from vault.secrets where name in ('cadence_engine_secret','notify_claim_submitted_secret','castle_health_daily_secret') order by name"
```

**Pass criteria:** all 3 rows returned.

### T5 — Intro draft flow (~30 sec)

**Setup:**
```bash
sql "insert into public.deals (id, name, address, type, status, lead_tier, surplus_estimate, sales_stage, meta) values ('sf-qa-bot-monday', 'QA Bot Monday Smoke', '999 QA Test Ln, Cincinnati OH 45069', 'surplus', 'new-lead', 'A', 50000, 'new', '{\"county\":\"Hamilton\",\"homeownerName\":\"QA Bot\",\"homeownerPhone\":\"+15555550199\",\"estimatedSurplus\":50000,\"feePct\":25,\"intake_type\":\"surplus\"}'::jsonb) on conflict (id) do update set meta = excluded.meta returning id"

QID=$(sql "insert into public.outreach_queue (deal_id, contact_phone, cadence_day, status, scheduled_for) values ('sf-qa-bot-monday', '+15555550199', 0, 'queued', now()) returning id" | jq -r '.[0].id')
echo "Queue ID: $QID"
```

**Action — fire generate-outreach:**
```bash
ANON=$(curl -sS "https://api.supabase.com/v1/projects/$PROJ/api-keys" -H "Authorization: Bearer $PAT" | jq -r '.[] | select(.name=="anon") | .api_key')
curl -sS -X POST "https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/generate-outreach" \
  -H "Authorization: Bearer $ANON" -H "apikey: $ANON" -H "Content-Type: application/json" \
  -d "{\"queue_id\":\"$QID\"}" | jq
```

**Verify:**
```bash
sql "select id, status, length(draft_body) as chars, draft_body, agent_reasoning from public.outreach_queue where id = '$QID'"
```

**Pass criteria:**
- Response: `{"ok":true, "queue_id":"...", "draft":"...", "reasoning":"..."}`
- DB: status=`pending`, `draft_body` populated (50-300 chars), `agent_reasoning` populated
- Draft text DOES NOT contain em-dashes (`—`), exclamation points, or emojis
- Draft includes "Nathan", "Hamilton" or "Hamilton County", and "999 QA Test Ln" or "QA Bot"

### T6 — STOP keyword silent DND (~20 sec)

**Setup:** keep the queue row from T5 in `pending` state.

**Action — simulate Twilio inbound STOP:**
```bash
curl -sS -X POST "https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/receive-sms" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "From=%2B15555550199&To=%2B15135162306&Body=STOP&MessageSid=qa_bot_stop_001"
```

**Verify all 4 effects:**
```bash
# 1. Stub contact with DND flags
sql "select do_not_text, do_not_call, dnd_reason from public.contacts where phone = '+15555550199'"
# 2. Queue row cancelled
sql "select status, skipped_reason from public.outreach_queue where id = '$QID'"
# 3. Activity row logged
sql "select action from public.activity where action like 'dnc_optout%' and created_at > now() - interval '2 minutes' order by created_at desc limit 1"
# 4. Inbound message stored
sql "select twilio_sid, body, direction from public.messages_outbound where twilio_sid = 'qa_bot_stop_001'"
```

**Pass criteria:**
1. `do_not_text=true, do_not_call=true, dnd_reason` includes "STOP keyword"
2. status=`cancelled`, skipped_reason=`dnc_optout`
3. action starts with `dnc_optout: STOP keyword from +15555550199`
4. body=`STOP`, direction=`inbound`

### T7 — send-sms DND filter (~10 sec)

The send-sms Edge Function requires a JWT with `sub`. Verify the DND-check SQL the function runs would match (proxy test):

```bash
sql "select id, phone, do_not_text from public.contacts where (phone = '+15555550199' or phone = '5555550199') and do_not_text = true limit 1"
```

**Pass criteria:** 1 row returned. If matched, `send-sms` would short-circuit to a 403 `{"error":"recipient_on_dnd"}` response.

### T8 — Cadence engine respects DND (~30 sec)

**Setup — backdated cadence_day=1 row that should NOT fire:**
```bash
sql "insert into public.outreach_queue (deal_id, contact_phone, cadence_day, status, scheduled_for, draft_body) values ('sf-qa-bot-monday', '+15555550199', 1, 'pending', now() - interval '5 minutes', 'Test Day 1 nudge') returning id" | jq
```

**Action — manually fire the cron function:**
```bash
sql "select public.fire_scheduled_outreach()"
sleep 3
```

**Verify the row stayed `pending` (DND blocked it):**
```bash
sql "select cadence_day, status, sent_at, error_message from public.outreach_queue where deal_id = 'sf-qa-bot-monday' and cadence_day = 1"
```

**Pass criteria:** status=`pending`, sent_at=null. The cron's `NOT EXISTS (...DND...)` clause should have skipped this row.

### T9 — Bulk-queue UI logic (no UI needed — proxy test) (~15 sec)

The BulkOutreachButton checks DND before inserting. Verify the logic by attempting an insert that mimics what the button would do for a DND'd deal:

```bash
sql "select c.id from public.contacts c where c.phone = '+15555550199' and c.do_not_text = true limit 1"
```

**Pass criteria:** Row returned. The button would skip this deal with reason "1 DNC".

### T10 — Reply Inbox surfaces inbound (UI optional — DOM only) (~30 sec, if Chrome MCP available)

Inbound message from T6 landed in `messages_outbound` with `read_by_team_at IS NULL`. Verify it appears in Reply Inbox query:

```bash
sql "select id, deal_id, body, read_by_team_at from public.messages_outbound where direction = 'inbound' and read_by_team_at is null and twilio_sid = 'qa_bot_stop_001'"
```

**Pass criteria:** 1 row returned (= would appear in Reply Inbox UI).

If Claude-in-Chrome is available:
1. Navigate to `https://app.refundlocators.com/#/`
2. Click `🚀 Outreach` in the nav
3. Verify the message body "STOP" appears in the Reply Inbox section's right column with the deal name "Nathan Test Deal" or similar
4. Click "Mark seen" → row disappears
5. Verify in DB: `select read_by_team_at from public.messages_outbound where twilio_sid = 'qa_bot_stop_001'` — should be NOT NULL now

### T11 — Castle Health Daily still green (~10 sec)

```bash
SECRET=$(sql "select decrypted_secret from vault.decrypted_secrets where name = 'castle_health_daily_secret' limit 1" | jq -r '.[0].decrypted_secret')
curl -sS -X POST "https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/castle-health-daily" \
  -H "X-Castle-Health-Daily-Secret: $SECRET" -H "Content-Type: application/json" -d '{}'
```

**Pass criteria:** `severity` is `green` (or worst case `transient` if a Castle agent is briefly stale). Not `chronic` or `critical`.

## Cleanup

```bash
sql "delete from public.outreach_queue where deal_id = 'sf-qa-bot-monday'"
sql "delete from public.activity where action like 'dnc_optout%' and created_at > now() - interval '15 minutes'"
sql "delete from public.messages_outbound where twilio_sid like 'qa_bot_%'"
sql "delete from public.deals where id = 'sf-qa-bot-monday'"
sql "delete from public.contacts where phone = '+15555550199' and do_not_text = true"
```

## What this DOES NOT verify

The Twilio integration loop itself is not exercised — `receive-sms` is invoked via direct curl matching Twilio's webhook payload format, not via real Twilio webhook traffic. To prove that loop end-to-end requires Nathan + a real phone:

1. Stage a real test deal with Nathan's actual phone in `meta.homeownerPhone`
2. Open DCC → Pipeline → click `🚀 Queue outreach`
3. Open Outreach view → click Send on the draft
4. Confirm Nathan's phone receives the SMS
5. Reply STOP from that phone
6. Confirm DND fires within ~5 sec

## Pass / fail report format

For each test T1-T11, output:
```
Tn — <test name>: ✅ PASS / ❌ FAIL / ⚠️ WARN
[ if FAIL/WARN, paste the exact response that didn't match expected criteria ]
```

End with overall: `OVERALL: N PASS / M FAIL / K WARN — Production-ready: YES/NO`.

If any FAIL: do NOT recommend going live Monday. Surface the specific failure to Nathan and suggest a fix.

## Known limitations to document — not failures

- **T7 proxy test:** can't exercise send-sms's full path without a valid user JWT. The SQL probe is the closest non-intrusive check.
- **T10 UI portion:** requires Claude-in-Chrome MCP. SQL-only path verifies the data layer.
- **No real Twilio:** carrier-level Advanced Opt-Out behavior on the Twilio dashboard is not testable via API. Confirm in Twilio Console → Messaging → Services → [your sender] → Opt-Out Management → Confirmation message is set to `"Unsubscribed. No more messages."` (Nathan should verify this manually before launch).
