# Mobile Notification System — Architecture & Spec

Drafted 2026-05-16 during autonomous Build 7 prep. Ships in stages: Build 7 lands the v1 scope below; Build 8+ adds the deferred items at the bottom.

## Goal

A coherent notification surface across the DCC mobile app:
- iOS app icon badge with total unread count
- In-app notification center listing all pending notifications
- Per-deal indicator (red dot) on deal cards in the list
- Per-tab unread badge (Team chat, etc.)
- Push notifications delivered to the phone via Expo Push → APNs
- Tap notification → deep-link to the right screen + auto-mark-read

## Data model

### `notifications` table

```sql
create table public.notifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  kind        text not null check (kind in (
    'inbound_sms',
    'docket_event',
    'team_message',
    'deal_status_change',
    'missed_call',
    'system_alert'
  )),
  deal_id     text references public.deals(id) on delete cascade,
  thread_id   uuid,                  -- team_messages.thread_id or null
  title       text not null,
  body        text,
  data        jsonb default '{}',    -- deep-link target + extra context
  created_at  timestamptz not null default now(),
  read_at     timestamptz
);
```

### Indexes

```sql
-- Hot path: "what's unread for me", "what's unread on this deal for me"
create index notifications_user_unread_idx on public.notifications(user_id, created_at desc)
  where read_at is null;
create index notifications_user_all_idx    on public.notifications(user_id, created_at desc);
create index notifications_deal_unread_idx on public.notifications(deal_id, user_id)
  where read_at is null;
```

### RLS

- `select`: `user_id = auth.uid()` — you only see your own
- `update`: `user_id = auth.uid()` — only mark your own read
- `insert`: SECURITY DEFINER triggers + service_role only — clients never insert directly
- `delete`: admin only (cleanup is server-side)

### Read-tracking RPCs

| RPC | Purpose |
|---|---|
| `mark_notification_read(p_notification_id uuid)` | One row → read |
| `mark_all_read()` | All caller's unread → read |
| `mark_deal_read(p_deal_id text)` | All caller's unread tied to that deal → read |
| `mark_thread_read(p_thread_id uuid)` | All caller's unread for that team thread → read |

All `SECURITY INVOKER` (run with caller's perms) — RLS update policy enforces that you can only mark your own.

### Aggregate views

```sql
create or replace view public.v_user_unread_count as
select user_id, count(*)::int as unread_count
from public.notifications
where read_at is null
group by user_id;

create or replace view public.v_deal_unread_for_user as
select user_id, deal_id, count(*)::int as unread_count
from public.notifications
where read_at is null and deal_id is not null
group by user_id, deal_id;
```

## Trigger sources (server-side)

### Inbound SMS — `messages_outbound` direction='inbound'

Trigger fires after INSERT where `direction='inbound'`:
1. For every admin user (role IN ('admin','user')), insert one `notifications` row with:
   - `kind='inbound_sms'`
   - `deal_id` (from the message row)
   - `title` = sender contact name (resolved from contact_id or to_number) or the raw phone
   - `body` = first 100 chars of `messages_outbound.body`
   - `data` = `{ "target": "deal/comms", "deal_id": "...", "message_id": "..." }`
2. Skip if STOP keyword (the DND inbound — no notification noise)
3. Fire `send-push-notification` edge function via `net.http_post` per admin user

### Team messages — `team_messages` INSERT

Trigger fires after INSERT where `sender_id != recipient_id` (or per-thread fanout):
1. For every recipient of the thread (other than sender), insert `notifications` row with:
   - `kind='team_message'`
   - `thread_id`
   - `title` = sender's name
   - `body` = first 100 chars
   - `data` = `{ "target": "team/thread", "thread_id": "..." }`
2. Fire push notification

### Deferred (Build 8+)

- **Docket events:** notify deal owner on `docket_events` insert
- **Deal status change:** notify owner on `deals.status` update
- **Missed calls:** wired into dialer flow once telemetry is stable
- **System alerts:** existing `system_alerts` flow extended

## Push delivery

Existing edge function `send-push-notification` already POSTs to Expo Push Service. We extend it minimally to accept:

```json
{
  "user_id": "<uuid>",
  "title": "New text from Jane Doe",
  "body": "Hi, I got your message about the surplus...",
  "data": { "target": "deal/comms", "deal_id": "surplus-doe" }
}
```

It:
1. Looks up `profiles.expo_push_token` for the user
2. POSTs to `https://exp.host/--/api/v2/push/send`
3. Returns success/failure (logged to function logs)

When the user taps the push notification, expo-notifications fires the `subscribeToNotificationTaps` handler in `mobile/lib/push.ts` with the `data` payload. That handler reads `data.target` and routes via expo-router.

## Mobile UI

### App icon badge (iOS native)

`mobile/lib/badge.ts`:
- On notification received (foreground or background): increment local count, call `Notifications.setBadgeCountAsync(N)`
- On `mark_read` / `mark_all_read` RPC: decrement / clear, update badge
- On app foreground: re-query `v_user_unread_count` to reconcile drift (e.g., reads on another device)

### Notification center screen

Route: `mobile/app/notifications.tsx`

- Header: "Notifications" + "Mark all read" button (calls `mark_all_read()` RPC)
- Body: FlatList of notifications, descending by `created_at`
- Each row: kind icon + title + body snippet + relative time ("2m", "1h", "yesterday")
- Tap row → routes to `data.target`, calls `mark_notification_read(id)` in fire-and-forget mode
- Pull to refresh + realtime subscription via Supabase for live updates

Access from any screen via a bell icon in the header (currently no bell — add one to `mobile/app/_layout.tsx`).

### Per-deal indicator

In `mobile/app/(tabs)/index.tsx` (or wherever the deal list renders):
- Join `v_deal_unread_for_user` to the deal list query
- Render small red dot on deal cards where `unread_count > 0`
- Show number inside the dot when `unread_count >= 2`

### Per-tab badge

Bottom nav (if present) — Team chat tab shows a badge counted from `notifications WHERE kind='team_message' AND read_at IS NULL`.

### Deep-link routing

`mobile/lib/notifications-router.ts`:
- Accepts a `data` payload
- Maps `data.target` to a route:
  - `"deal/comms"` → `/deal/${deal_id}?tab=comms`
  - `"deal/docket"` → `/deal/${deal_id}?tab=docket`
  - `"team/thread"` → `/team-thread/${thread_id}`
- Calls `router.push(...)`
- Marks the notification read

## Build 7 ship scope

Implementing now:
- ✅ `notifications` table + 3 indexes + RLS
- ✅ 4 read-tracking RPCs (`mark_notification_read`, `mark_all_read`, `mark_deal_read`, `mark_thread_read`)
- ✅ 2 aggregate views
- ✅ 2 server-side triggers: `tg_notify_inbound_sms` + `tg_notify_team_message`
- ✅ `send-push-notification` edge function extended for the new shape
- ✅ Mobile: badge wiring (`mobile/lib/badge.ts`)
- ✅ Mobile: notification center screen
- ✅ Mobile: per-deal dot indicator on deal cards
- ✅ Mobile: bell icon in header → notification center
- ✅ Mobile: deep-link router
- ✅ Mobile: realtime subscription on `notifications`

## Deferred (Build 8+)

- Smart batching ("3 new messages from Jane Doe" rolled into one row when in quick succession)
- Grouping by date in notification center (Today / Yesterday / Earlier headers)
- Triggers for docket_event, deal_status_change, missed_call
- Notification preferences screen (per-kind opt-in/out, quiet hours)
- Per-thread badge counts on the Team Chat list view (different from per-tab)
- Web version of all this (DCC already has some chat badge code in `src/app.jsx` lines ~21900 — could unify)
