# Monday-launch outreach pipeline — Justin handoff

**From:** Nathan (via DCC Claude)
**To:** Justin
**Date:** 2026-04-25
**Goal date:** Sunday night, so Nathan can start pushing A/B leads through Monday morning.
**Estimated effort:** ~5-7 hrs total across 4 small workstreams. None depend on each other.

## What Nathan is doing Monday

Pushing Castle-scored **tier A and B** leads into DCC, sending each one a custom personalized SMS with their `refundlocators.com/s/<token>` link, then putting them on an automated cadence drip. Inbound replies come back; Lauren intakes (in week 2 — not Monday); Nathan triages everything by hand in week 1 via a new **Outreach view** on DCC (already shipped, commit `a8da280`).

The DCC side is in place. Four small pieces in your lane are needed to complete the loop. None block each other; ship in any order.

---

## Piece 1 — `generate-outreach` includes the personalized link in the first text

**Effort:** ~30 min
**Files:** `supabase/functions/generate-outreach/index.ts`

When `cadence_day = 0` (the intro draft) and the deal has an active row in `personalized_links` (joined on `personalized_links.deal_id = deal.id`), include the URL `https://refundlocators.com/s/<token>` in the draft body.

Castle just shipped 19 personalized links yesterday. Schema highlights:

```
personalized_links (Castle-owned, in DCC's Supabase project rcfaashkfpurkvtmsmeb):
  token text PK (8-char nanoid)
  deal_id uuid (nullable for orphan links — skip those, fall back to no link)
  first_name, last_name, property_address, county
  expires_at (90 days from creation — skip if expired)
  source ('castle-v2' or 'castle-v2-auction')
```

Suggested draft pattern (loose — adjust per Castle's voice):

> Hi {first_name}, this is Nathan from RefundLocators. I noticed your foreclosure on {property_address}. The court is holding ${surplus_low}-${surplus_high} in surplus funds you may be entitled to. Here's your case page with the details: refundlocators.com/s/{token}

Constraints:
- Stay under 320 chars (allows 2-segment SMS without 3-segment cost)
- Don't include the link unless it exists + isn't expired
- If `personalized_links.responded_at` is already set, skip queueing this entry — they've already engaged
- Same draft prompt rules as today: no em-dashes, no JSON garbage, plain conversational

For `cadence_day > 0` (follow-ups), use the same link in the URL in any follow-up that asks them to "check your case info" — but never include it twice in the same thread.

---

## Piece 2 — Cadence engine (pg_cron + outreach_queue)

**Effort:** ~2 hrs
**Files:** new SQL migration + `supabase/functions/send-sms` may not need changes (just needs to be invoked by a new orchestrator)

Goal: when an outreach_queue row hits `scheduled_for <= now()` AND status is `'pending'` (Nathan-approved drafted but not yet sent), the system fires send-sms automatically. **Caveat: only auto-fire on cadence_day >= 1 (follow-ups).** The cadence_day = 0 intro must always require Nathan-approved click-to-send. Drips can run unattended.

Suggested architecture:

```sql
-- Migration: pg_cron job every 15 min walks outreach_queue
create or replace function public.fire_scheduled_outreach()
returns void language plpgsql security definer set search_path = public as $$
declare
  rec record;
  fn_secret text;
begin
  select decrypted_secret into fn_secret from vault.decrypted_secrets
    where name = 'cadence_engine_secret' limit 1;
  if fn_secret is null then return; end if;

  for rec in
    select * from public.outreach_queue
    where status = 'pending'
      and scheduled_for is not null
      and scheduled_for <= now()
      and cadence_day >= 1               -- intro is human-gated, drips are auto
      and not exists (                    -- DNC respect
        select 1 from public.contacts c
        where c.phone = outreach_queue.contact_phone
          and c.do_not_text = true
      )
  loop
    -- Fire send-sms with the queued draft body. Use a new dispatch endpoint
    -- or call send-sms directly from a small dispatch-cadence Edge Function.
    perform net.http_post(
      url := 'https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/dispatch-cadence-message',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'X-Cadence-Secret', fn_secret
      ),
      body := jsonb_build_object('queue_id', rec.id)::jsonb
    );
  end loop;
end;
$$;

select cron.schedule('outreach-cadence', '*/15 * * * *',
  $$select public.fire_scheduled_outreach()$$);
```

Then a tiny `dispatch-cadence-message` Edge Function that:
1. Reads the outreach_queue row by id
2. Re-checks DNC + status (race-safe)
3. Calls send-sms with `{to: contact_phone, body: draft_body, deal_id, contact_id}`
4. Marks `outreach_queue.status = 'sent'` + sets `sent_at`
5. Inserts the next cadence_day row (e.g., day 2 → day 4 → day 7 → done)

**Default cadence ladder (Nathan-approved 2026-04-25, you can tune):**
- Day 0: intro (human-gated)
- Day 2: nudge ("just checking — did you see the link?")
- Day 4: case-study ("this matters — here's an example of what we recovered for someone in your situation")
- Day 7: last-chance ("final check before I stop reaching out")
- Day 8+: drop, no further outbound

Each follow-up is drafted by `generate-outreach` the moment its `outreach_queue` row is inserted (your existing auto-fire logic from today's PR #12 takes care of that).

---

## Piece 3 — STOP keyword + DNC handling

**Effort:** ~1 hr
**Files:** `supabase/functions/receive-sms/index.ts` + new column on `contacts`

When an inbound SMS body matches `STOP`, `UNSUBSCRIBE`, `QUIT`, `END`, `CANCEL`, or `OPT OUT` (case-insensitive, trimmed):

1. Set `contacts.do_not_text = true` on the matching contact (match by phone, normalized to E.164)
2. Cancel any future cadence rows: `update outreach_queue set status='cancelled' where contact_phone = ... and status in ('pending', 'queued')`
3. Auto-reply once with a confirmation: `"You won't hear from this number again. If this was a mistake, reply START to resume."` — this is required by Twilio + carrier rules
4. Log an `activity` row: `type='dnc_optout'` so Nathan sees it

Migration needed:

```sql
alter table public.contacts add column if not exists do_not_text boolean default false;
create index if not exists idx_contacts_do_not_text on public.contacts(phone) where do_not_text = true;
```

A2P 10DLC compliance is genuinely required here; without it carriers will start filtering refundlocators.com SMS. Nathan said earlier "we have it resolved" on A2P registration but the in-DB DNC list is still missing.

---

## Piece 4 — SMS-to-Nathan-cell when inbound lands

**Effort:** ~30 min
**Files:** `supabase/functions/receive-sms/index.ts`

Today: inbound SMS triggers `messages_email_notify` which emails Nathan. He needs SMS too — he's mobile-first.

After the existing email path, add a Twilio SMS to Nathan's personal cell with:
> 💬 {claimant_name}: "{body, first 100 chars}" — DCC: {deal_name}

Two prerequisites:
1. **Nathan tells you which number is his personal cell.** It's NOT 513-516-2306 (that's the business line — the inbound). Probably whatever's listed on his profile in `profiles` table, or a new vault secret `nathan_personal_cell`.
2. **Twilio sender number for the alert** — Nathan's pulse line works (the same outbound number that texts claimants), since he can distinguish "from RefundLocators biz line" vs "to my cell" by the To address.

Optional: confidence floor — only fire SMS if the inbound is from a number that matches a known deal (i.e., not random spam). Pulled from the same logic that sets `messages_outbound.deal_id` in receive-sms.

---

## Piece 5 (later, post-Monday) — Lauren intake-and-classify

**Don't ship this for Monday.** Spec only. Nathan is supervised mode for the first week — every reply is human-handled.

Once the system is generating drafts via `generate-outreach`, Lauren takes over the intake side. Build is similar to the Lauren no-reply ping (`JUSTIN_LAUREN_NO_REPLY_PING_SPEC.md` from earlier today) but simpler — there's no 60-sec wait, just process every inbound:

Trigger: every `messages_outbound` insert with `direction='inbound'` AND `deal_id is not null` AND inbound came on the business line (`to_number = '+15135162306'`).

Lauren reads:
- The inbound message
- Last 10 messages in the thread (both directions)
- Deal metadata: status, surplus estimate, attorney, case number, county
- Any `personalized_links` row for this deal (was claim_submitted_at set?)

Lauren returns a structured payload:
```json
{
  "action": "auto_reply" | "draft_for_review" | "escalate_urgent" | "no_action",
  "draft_reply": "string or null",
  "confidence": 0.0-1.0,
  "category": "faq" | "scheduling" | "objection" | "buying_signal" | "complaint" | "legal" | "off_topic" | "stop",
  "reasoning": "short sentence for Nathan to grade her thinking"
}
```

Routing rules (proposed — Nathan + Justin tune in a sync):
- `confidence ≥ 0.85` AND `category ∈ {faq, scheduling}` AND playbook approves → auto-send (week 2+ only)
- `confidence ≥ 0.6` → draft sits in Outreach view's "Lauren drafts" section, Nathan reviews + sends
- `confidence < 0.6` OR `category ∈ {objection, buying_signal, complaint, legal}` → urgent ping to Nathan (SMS to cell + DCC toast)
- `category = stop` → fire DNC handler from Piece 3

Storage: new `lauren_drafts` table keyed on `inbound_message_id`. Mirror the structure of Justin's outreach_queue but for inbound.

UI integration: I'll add a "Lauren drafts" panel to the Outreach view next to Reply Inbox once your edge function lands.

**This is the centerpiece of the long-term vision** but has the most surface area to get wrong. Better to ship Monday in supervised mode, build trust over week 1, then turn this on for FAQ-only categories first.

---

## What's already in place on the DCC side

Don't re-build any of these — they're shipped:

- **Outreach top-level view** — commit `a8da280` on DCC main. Stats tiles, AutomationsQueue (your component, untouched), ReplyInbox.
- **Reply Inbox component** — reads `messages_outbound where direction='inbound' and read_by_team_at is null`. Realtime, marks-seen on click. **Important: the `read_by_team_at` column is what your inbound code should NOT set automatically — that's user-action driven from DCC's UI.** Just leave it null on insert.
- **CaseHero + Court Activity scroller + invite-link buttons** in client portal — shipped earlier today.
- **Castle Health Daily** — shipped today, monitors Castle's 5 agents nightly. If court_pull goes red Monday morning, Nathan gets the email at 9am ET.
- **personalized-link claim loop fix** — column migration + trigger + notify-claim-submitted Edge Function. When claimants submit via `/s/<token>`, Nathan gets SMS+email within 5 sec.

---

## Lane boundaries

Your lane (don't think DCC needs to touch any of these):
- generate-outreach Edge Function
- receive-sms Edge Function
- send-sms Edge Function
- messages_outbound table
- outreach_queue table
- contacts.do_not_text column (Nathan owns the schema migration but you own the read/write logic)
- Lauren / pgvector
- Twilio account config
- iMessage bridge (Mac Mini)

Nathan's lane (don't touch):
- DCC index.html (he/DCC Claude will integrate with your APIs)
- Client portal portal.html
- Castle's docket-webhook
- Any of the email triggers (docket_events_client_notify, messages_email_notify)

Shared (coordinate via WORKING_ON.md before writing migrations):
- contacts table (you'll add do_not_text; he'll add other fields if needed)
- deals, activity, deal_notes, documents

---

## Sequencing

Pieces 1-4 are independent. Suggested order (lowest risk first):

1. **Piece 1** (link in draft) — 30 min, isolated change to one Edge Function
2. **Piece 4** (SMS to cell) — 30 min, additive to existing receive-sms email path
3. **Piece 3** (STOP + DNC) — 1 hr, adds column + receive-sms branch
4. **Piece 2** (cadence engine) — 2 hr, pg_cron + new dispatcher Edge Function

If you only have 2 hours, ship 1+4. That's enough to launch Monday in fully manual mode (Nathan sends each cadence drip by hand). 2+3 turn it into automation.

---

## Coordination

Push to `main` as you ship. No PRs needed — Nathan + DCC Claude will sync via `git pull` in the morning. If you write a migration that touches a shared table, drop a one-liner in `WORKING_ON.md` so DCC's Claude session knows.

Reply to Nathan in iMessage when each piece lands so he can tee up real testing. The 19 personalized links Castle generated last night are perfect smoke tests — pick one, force-queue an outreach_queue row for that deal, watch the draft flow end to end.

---

## Open questions for Nathan to answer (he can DM you)

1. Personal cell number for Piece 4 — want it in vault or hardcoded in env?
2. Cadence ladder — Day 2/4/7 the right rhythm? Or shorter (Day 1/3/5) given the 5-year escheat clock?
3. STOP auto-reply text — fine with the suggested copy, or want to tune?
4. Lauren intake — start playbook design this week so Piece 5 has a real spec by next weekend?

Ship what you can, leave the rest open. Monday will tell us what's actually broken.
