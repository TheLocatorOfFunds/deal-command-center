# Lauren "no-reply ping" — spec for Justin

**From:** Nathan (via DCC Claude)
**To:** Justin's Claude session
**Date:** 2026-04-24
**Scope:** Lauren + SMS domain (yours). DCC only renders the result.

## The ask (Nathan's words)

> When someone responds to the 513-516-2306 phone number, I want there to be a
> notification to Lauren to then prompt me by ping and let me know what she
> thinks we should do. This would be only if someone that is **in the DCC**
> responds to 513-516-2306 and **I don't respond within 1 min.**

## The trigger — precise definition

Fire Lauren when ALL of these are true for an inbound message on 513-516-2306:
1. `messages_outbound.direction = 'inbound'`
2. `messages_outbound.to_number = '+15135162306'` (or the stored variant)
3. `messages_outbound.deal_id is not null` — "in the DCC" means the number
   matched a known deal. If Justin's `receive-sms` didn't match the number
   to a deal, the sender is a stranger and Lauren stays out.
4. Nathan has NOT sent an outbound reply on that same thread (`deal_id` +
   `from_number`) since the inbound arrived, for at least **60 seconds**.
5. No Lauren ping has already been generated for this message (idempotent).

## Architecture — 4 moving pieces

```
┌──────────────┐   ┌─────────────────┐   ┌──────────────┐   ┌─────────┐
│ receive-sms  │ → │ lauren-scanner  │ → │ Lauren (LLM) │ → │ ping-   │
│  (existing)  │   │  (pg_cron, 30s) │   │              │   │ nathan  │
└──────────────┘   └─────────────────┘   └──────────────┘   └─────────┘
                           │                    │                  │
                           ▼                    ▼                  ▼
                    lauren_pings           lauren_pings        DCC toast
                    (status=pending)       (status=ready)      + SMS to
                                           + recommendation    Nathan's cell
```

### Piece 1 — `lauren_pings` table (new)

```sql
create table public.lauren_pings (
  id                 uuid primary key default gen_random_uuid(),
  deal_id            text not null references public.deals(id) on delete cascade,
  inbound_message_id uuid not null references public.messages_outbound(id) on delete cascade,
  from_number        text not null,
  inbound_snippet    text not null,    -- first 300 chars of the inbound body
  status             text not null default 'pending'
    check (status in ('pending', 'suppressed', 'ready', 'dismissed', 'acted_on')),
  -- 'suppressed' = Nathan replied within 60s before Lauren even ran
  -- 'ready'      = Lauren produced a recommendation, awaiting Nathan
  -- 'dismissed'  = Nathan saw it and chose to ignore
  -- 'acted_on'   = Nathan sent Lauren's suggested reply (or an edit of it)

  recommendation     jsonb,            -- { action, draft_reply, confidence, reasoning }
  confidence         numeric,          -- 0..1, mirrored from recommendation for easy filter
  delivery           jsonb,            -- { toast_at, sms_at, email_at } - which channels fired
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  resolved_at        timestamptz,
  unique (inbound_message_id)          -- one ping per inbound, idempotent
);

create index idx_lauren_pings_status on public.lauren_pings(status, created_at desc);
create index idx_lauren_pings_deal   on public.lauren_pings(deal_id, created_at desc);
```

RLS: admin-only read/write. VAs don't need these (Nathan-facing).

### Piece 2 — `lauren-scanner` (pg_cron every 30s)

```sql
-- Runs every 30s. Claims inbound messages aged 60-180s with no outbound
-- reply, inserts lauren_pings rows in 'pending', then fires generate-lauren-ping
-- via pg_net. Skips anything already in lauren_pings.
create or replace function public.scan_for_lauren_pings()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  rec record;
  fn_secret text;
begin
  select decrypted_secret into fn_secret from vault.decrypted_secrets
    where name = 'lauren_ping_secret' limit 1;
  if fn_secret is null then return; end if;

  for rec in
    select m.id, m.deal_id, m.from_number, m.body, m.created_at
    from public.messages_outbound m
    where m.direction = 'inbound'
      and m.to_number = '+15135162306'     -- Nathan's number (pull from phone_numbers if stored there)
      and m.deal_id is not null            -- "in the DCC"
      and m.created_at < now() - interval '60 seconds'
      and m.created_at > now() - interval '10 minutes'  -- don't scan far-back history
      and not exists (
        select 1 from public.lauren_pings lp
        where lp.inbound_message_id = m.id
      )
      and not exists (
        -- Nathan already replied on this thread since the inbound
        select 1 from public.messages_outbound r
        where r.deal_id = m.deal_id
          and r.direction = 'outbound'
          and r.to_number = m.from_number
          and r.created_at > m.created_at
      )
  loop
    insert into public.lauren_pings (deal_id, inbound_message_id, from_number, inbound_snippet)
    values (rec.deal_id, rec.id, rec.from_number, left(rec.body, 300));

    -- Fire the Lauren generation edge function
    perform net.http_post(
      url := 'https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/generate-lauren-ping',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'X-Lauren-Ping-Secret', fn_secret
      ),
      body := jsonb_build_object('inbound_message_id', rec.id)::jsonb
    );
  end loop;
end;
$$;

select cron.schedule('lauren-ping-scanner', '*/1 * * * *', $$select public.scan_for_lauren_pings()$$);
-- pg_cron's minimum is 1min; if you want 30s granularity, run it twice per minute via duplicate schedule,
-- or move the scanner into an Edge Function called by pg_cron. For v1, 1min is fine — Nathan's 60s
-- trigger means worst case he gets the ping at 60-120s, which is acceptable.
```

### Piece 3 — `generate-lauren-ping` Edge Function (new)

Input: `{ inbound_message_id: uuid }`
Auth: `X-Lauren-Ping-Secret` header

1. Load the inbound message + deal context + last 10 messages in this thread.
2. **Re-check the "Nathan didn't reply" condition** — the scanner ran on stale
   data, he may have replied in the 5-30s between scan and fn-call. If he did,
   update `lauren_pings.status = 'suppressed'` and exit.
3. Build a prompt with:
   - Deal metadata: status, county, estimated surplus, attorney, case number
   - Last 10 messages in the thread (role + body + timestamp)
   - The new inbound message verbatim
   - Lauren's system prompt (see below)
4. Call Claude (or whatever model Lauren uses) with Lauren's knowledge base
   retrieved via pgvector.
5. Parse the response into `{ action, draft_reply, confidence, reasoning }`:
   - `action` ∈ `['send_reply', 'call_back', 'escalate_to_nathan_urgent', 'mark_handled', 'wait']`
   - `draft_reply`: a proposed SMS (nullable if action != 'send_reply')
   - `confidence`: Lauren's self-reported 0..1
   - `reasoning`: 1-2 sentences for Nathan
6. `update lauren_pings set status='ready', recommendation=..., confidence=... where inbound_message_id = ...`
7. Fire `ping-nathan` for delivery.

### Lauren's system prompt (starting point)

```
You are Lauren, RefundLocators' case-assistant AI. A homeowner or attorney
has texted Nathan at 513-516-2306 and Nathan hasn't replied within 60
seconds. Your job is to give Nathan a recommendation on what to do.

Available actions:
- send_reply: you provide a draft_reply Nathan can send with one tap
- call_back: too nuanced for text — Nathan should phone them
- escalate_to_nathan_urgent: time-sensitive, interrupt whatever he's doing
- mark_handled: the message is noise (spam, wrong number, already-answered Q)
- wait: non-urgent, can sit in the normal queue

Constraints on draft_reply if you choose send_reply:
- Under 160 chars if possible (single SMS segment)
- No em dashes. No emoji unless homeowner used one first.
- Plain, warm, specific. Sign off as "— Nathan" only if the thread already
  shows he signs that way.
- If you don't have enough context to draft well, choose call_back instead
  of hallucinating specifics.

Return valid JSON: {"action": "...", "draft_reply": "...", "confidence": 0.7, "reasoning": "..."}
```

Note: Justin, Lauren's `lauren_knowledge` table doesn't exist yet per your
prior audit. For v1, skip the pgvector retrieval — just pass the deal
metadata + thread history directly in the prompt. Add retrieval later when
the knowledge base is seeded.

### Piece 4 — `ping-nathan` delivery

Nathan's preference (his words to confirm — default below):
- **Primary**: toast/banner in DCC if his browser has the app open (realtime
  on `lauren_pings` INSERT with `status='ready'`).
- **Fallback**: SMS to Nathan's personal cell (NOT 513-516-2306 — that's the
  business number). Nathan will need to tell you which number to use; check
  `profiles` for his row or use a new `nathan_personal_number` secret in vault.
- **Confidence floor**: only SMS if `confidence >= 0.6` OR
  `action = 'escalate_to_nathan_urgent'`. Low-confidence suggestions stay in
  the DCC toast so they don't blow up his phone.
- Record delivery channels in `lauren_pings.delivery` jsonb.

## DCC-side UI (I'll build this once your backend lands)

- Realtime subscription to `lauren_pings where status='ready'`
- Floating toast in the top-right of index.html when a new one lands
- Toast shows: homeowner name, inbound snippet (italic), Lauren's recommended
  action, and the draft_reply in an editable textarea
- Buttons: **Send as-is** (fires send-sms with Lauren's draft → marks
  `status='acted_on'`), **Edit & send**, **Dismiss**, **Open deal**
- Attention view gets a new row: "🤖 Lauren suggests a reply · {deal_name} · 2m ago"

Commit this spec to the same branch as your PR so Nathan can diff it against
what you shipped. Once backend lands, ping back and I'll wire the toast.

## Edge cases / things to think about

1. **Message Nathan sent via Mac Mini iMessage bridge** — does the bridge
   write outbound rows to `messages_outbound`? If yes, the "did Nathan reply"
   check covers iMessage sends. If no, we'll false-positive and ping Lauren
   even when Nathan already answered via his phone. Confirm the bridge writes
   both directions to `messages_outbound`.

2. **Group threads** — if Nathan tags two people in a conversation, does the
   inbound from person A trigger Lauren even if person B replied first? The
   current "did Nathan reply" check is keyed on `from_number` matching the
   inbound sender, so group context might mis-fire. Handle later if it comes
   up — for v1 treat each from_number as its own thread.

3. **Rate limiting** — if someone sends 20 texts in a row, do we fire Lauren
   20 times or once per 5 minutes per thread? Suggest: one ping per thread per
   hour, collapse new inbounds into the existing pending ping by updating
   `inbound_snippet`.

4. **Justin's outreach_queue overlap** — your `outreach_queue` already has a
   human-in-loop draft/send/skip flow. Is Lauren-ping just a specialization of
   that? Consider whether a ready `lauren_pings` row should just create an
   `outreach_queue` row with `cadence_day = null, trigger = 'lauren_reply'` so
   both flows render in the same UI.

5. **Testing** — manual trigger: insert a fake inbound row with
   `created_at = now() - interval '61 seconds'` and watch the scanner pick it
   up within ~1 minute.

## Rollout

- Ship Piece 1 (table) + Piece 2 (scanner with pg_cron disabled) first.
- Ship Piece 3 (edge fn) with Lauren's system prompt, run it manually against
  a few real inbound messages Nathan already handled, sanity-check the output.
- Once Lauren's output looks reasonable, enable the pg_cron schedule.
- Ship Piece 4 (ping delivery) last — this is the loud part.
- DCC UI toast is additive and can ship independently after backend is live.

## Handoff back to DCC

When you're done, post a note in `WORKING_ON.md` with:
- Confirmation that `lauren_pings` table exists
- The secret name in vault
- Whether realtime on `lauren_pings` works for admin users
- Any changes to Lauren's system prompt you ended up making

Then I'll wire the DCC toast + Attention row.
