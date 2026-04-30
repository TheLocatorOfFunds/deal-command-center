# lauren-event-router

The notification path for Lauren activity. Replaces the old
`textNathan` SMS that lived inside `lauren-chat` (which is being
removed in the hardened version — see
`supabase/functions/lauren-chat/README.md`).

## How it works

```
lauren_conversations  ──(trigger)──►  lauren_event_dispatch()  ──(pg_net.http_post)──►  lauren-event-router
   (website logs)                                                                          │
                                                                                          ├─ pulls row
                                                                                          ├─ classifies signal
                                                                                          ├─ dedupes against lauren_alerts
                                                                                          ├─ sends email via Resend
                                                                                          └─ writes lauren_alerts row
```

Three triggers fire `lauren_event_dispatch()`:

| Trigger | When | Event payload |
|---|---|---|
| `tg_lauren_conversation_inserted` | INSERT on `lauren_conversations` | `event: 'started'` |
| `tg_lauren_conversation_submitted` | UPDATE where `submitted_claim` flipped FALSE → TRUE | `event: 'submitted'` |
| `tg_lauren_conversation_message_added` | UPDATE where `message_count` increased | `event: 'message_added'` |

The router decides which of these are actually alert-worthy:

| Signal | Decision rule |
|---|---|
| `claim_submitted` | Always alert (highest value). |
| `token_chat_started` | Alert if `token` is present (came from `/s/[token]`). |
| `engaged_chat` | Alert on a generic-mode chat once `message_count >= 5` (real conversation, not bounce). |
| `keyword_hit` | Alert if the latest user message contains a watchlist word: scam, lawyer, attorney, AG, sue, complaint, BBB, fraud, news, police, etc. |

Dedupe: if the same `(visitor_id, signal_type)` already produced an
alert within the last 1 hour, skip. Tune `DEDUPE_HOURS` in `index.ts`.

## Email destination

Goes to **nathan@fundlocators.com** only. No SMS, no other recipients.

## Endpoint

URL: `https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/lauren-event-router`
verify_jwt: false (auth via shared secret in header)
Auth header: `X-Lauren-Event-Secret: <secret>`

## Required Vault secrets

- `lauren_event_secret` — random 32+ char string. Used by the trigger
  function to authenticate to this Edge Function. Set with:
  ```sql
  INSERT INTO vault.secrets (name, secret)
  VALUES ('lauren_event_secret', '<random>');
  ```
- `resend_api_key` — already exists for `notify-claim-submitted` and
  `send-email`. Reused.

## Required env vars on the Edge Function

- `LAUREN_EVENT_SECRET` — same value as the Vault secret above. Set in
  Supabase Edge Function dashboard → secrets.
- `SUPABASE_URL` — auto-provided.
- `SUPABASE_SERVICE_ROLE_KEY` — auto-provided.

## Deploy

```
supabase functions deploy lauren-event-router --project-ref rcfaashkfpurkvtmsmeb --no-verify-jwt
```

Then run the migration `20260430220000_lauren_event_router.sql` to
create the `lauren_alerts` table + the three triggers + the dispatch
function.

## Testing

Smoke test once deployed:

```sql
-- Force an "engaged_chat" alert
UPDATE lauren_conversations
   SET message_count = 5, last_message_at = now()
 WHERE id = '<some-conversation-id>';
```

Or hit the Edge Function directly:

```
curl -X POST https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/lauren-event-router \
  -H "X-Lauren-Event-Secret: <secret>" \
  -H "Content-Type: application/json" \
  -d '{"event":"submitted","conversation_id":"<uuid>"}'
```

Expected: a row in `lauren_alerts`, an email at nathan@fundlocators.com.

## Future work

- Daily AI-review cron (Justin's Task 7) — this router only catches
  pre-listed keywords. A nightly Claude pass over the day's
  conversations catches novel patterns.
- DCC sidebar that renders unacknowledged `lauren_alerts` rows. The
  existing `lauren_alert_acks` table already has the (conversation_id,
  acknowledged_at, acknowledged_by) shape for that.
- Throttle policy refinement once we see real volume.
