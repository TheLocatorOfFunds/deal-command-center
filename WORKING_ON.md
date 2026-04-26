# Currently Working On

Two parallel Claude Code sessions share this repo. Update this file at the start and end of
every session so the other side knows what's in flight.

---

## Justin's session

**Status**: Idle
**Last done**: Multi-contact SMS — per-contact tabs, group chat routing, reaction pills, group-chat leak fix. Schema: `message_groups`, `messages_outbound_unmatched`, `thread_hidden`, new cols on `messages_outbound`. Edge functions `send-sms` + `receive-sms` redeployed. Mac Mini bridge updated + restarted.
**Last updated**: Apr 23, 2026

---

## Nathan's session

**Status**: Active — Monday-launch outreach pipeline pre-build
**Last done (Apr 25, 2026 evening, multiple commits)**:

Big-batch sprint preparing for Monday push of A/B-tier leads through outreach. Justin: heads up — Nathan's session shipped pieces that nominally sit in your lane this time. Per his explicit direction. Below is the diff summary so your session catches up on a single git pull.

**Schema changes (live in production):**
- `messages_outbound.read_by_team_at timestamptz` — UI marks-seen state for the new Reply Inbox in DCC
- `contacts.do_not_text boolean default false` — DND, blocks all outbound SMS
- `contacts.do_not_call boolean default false` — DND, must be respected by future click-to-call
- `contacts.dnd_set_at timestamptz` — when the flags flipped
- `contacts.dnd_reason text` — audit trail
- `docket_events.litigation_stage / deadline_metadata / attorney_appearance` — Castle's Apr 25 sprint additions, captured by the updated docket-webhook
- `docket_events_unmatched.litigation_stage / deadline_metadata / attorney_appearance` — same
- `personalized_links.mailing_address text` — was missing, marketing-site `/api/s/claim` was silently failing every submission
- `personalized_links.claim_submitted_at timestamptz` — same

**New Edge Functions:**
- `notify-claim-submitted` — fires SMS+email to Nathan when a personalized_links row's `claim_submitted_at` flips NULL→NOT NULL. Trigger-driven, vault secret `notify_claim_submitted_secret`
- `castle-health-daily` — daily scheduled "agent" reads v_scraper_health, calls Claude for prose summary + ranked actions, emails recipient on issues. pg_cron 13:00 UTC. Vault `castle_health_daily_secret`. Recipient via `CASTLE_HEALTH_RECIPIENT` Edge Function env var (default nathan@fundlocators.com)
- **`dispatch-cadence-message`** — cadence engine consumer. Auth via `X-Cadence-Secret` header (vault `cadence_engine_secret`). Re-validates DNC + status, fires `send-sms`, marks queue row sent, schedules next cadence row per ladder

**Modified Edge Functions:**
- **`receive-sms`** (v12) — added STOP-keyword silent DND handler at the bottom of the success path. Detects `stop / unsubscribe / quit / end / cancel / opt out`, sets `contacts.do_not_text=true AND do_not_call=true`, cancels future cadence rows for that contact_phone, logs activity. **No app-level reply** (Twilio carrier-level Advanced Opt-Out emits the required confirmation independently — set the messaging-service confirmation text to `"Unsubscribed. No more messages."` in your Twilio config). Header annotation in the file points back here.
- **`send-sms`** (v18) — added DND filter immediately after E.164 normalization. Returns 403 + `{error: "recipient_on_dnd"}` if the recipient is on `contacts.do_not_text=true`. Header annotation in the file.
- `docket-webhook` (v15) — captures Castle's three new optional jsonb fields (litigation_stage, deadline_metadata, attorney_appearance)

**New triggers + cron:**
- `sync_refundlocators_token()` — when `personalized_links.deal_id` flips from NULL→NOT NULL OR token changes, copies `personalized_links.token` to `deals.refundlocators_token` so your `generate-outreach` reads the link correctly
- `notify_personalized_claim_submitted()` — fires the `notify-claim-submitted` Edge Function on `personalized_links.claim_submitted_at` first-set
- `fire_scheduled_outreach()` + pg_cron `outreach-cadence` (every 15 min) — drains `outreach_queue` rows where `status=pending AND cadence_day>=1 AND scheduled_for<=now()` AND contact not on DNC. Calls `dispatch-cadence-message` for each. Cap 100/run. **Intro (cadence_day=0) is NOT auto-fired** — Nathan hand-clicks each first text from the Outreach view's AutomationsQueue.

**Cadence ladder (Nathan-set):**
Day 0 (human-gated) → Day 1 → Day 3 → Day 5 → Day 12, 19, 26, 33, 40, 47, 54, 61, 68, 75, 82, 90 (weekly drip) → drop. ~13 touches over 90 days. Implemented in `dispatch-cadence-message::nextCadenceDay()`.

**DCC UI (index.html):**
- New top-level **🚀 Outreach** view between Attention and Pipeline. Stats tiles + AutomationsQueue (your component, untouched) + new ReplyInbox component
- New **ReplyInbox** component — cross-deal `messages_outbound where direction='inbound' AND read_by_team_at IS NULL`, oldest first, realtime, mark-seen action. Click row → jumps to deal Comms tab
- Castle scraper health: ScraperHealthPanel (Reports) + ScraperAlertStrip (Attention) over `v_scraper_health` view
- Court deadline countdowns + litigation stage badges + attorney appearance callouts in DocketTab
- Cross-deal DeadlineAlertStrip in AttentionView
- Partner Attorney directory in ContactsModal — surfaces every distinct attorney from `docket_events.attorney_appearance` not yet in contacts; one-click "+ Add to Contacts" promote
- Client/Counsel Portal cards: per-claimant `📋 Copy invite link` + `📧 Email now` buttons
- portal.html: unified CaseHero, ?email=&invite=1 auto-send flow, Court Activity 4-entry scroller

**Spec docs Justin should read when picking back up:**
- `JUSTIN_LAUREN_NO_REPLY_PING_SPEC.md` — Lauren-pings-Nathan when he doesn't reply in 60s
- `JUSTIN_MONDAY_LAUNCH_SPEC.md` — full outreach pipeline spec including deferred Lauren intake-and-classify (with hard security requirements: prompt injection, info leakage, token exhaustion defenses)
- `CASTLE_TO_DCC_GAP_HANDOFF.md` — multi-session gap analysis with audit findings on both sides

**One Twilio config item that needs your touch in the dashboard (no code):**
- Set the messaging service Advanced Opt-Out confirmation text to `"Unsubscribed. No more messages."` (carrier-level, not in our codebase). This is the only acknowledgement that fires when someone texts STOP — our app code is silent on top.

**Last updated**: Apr 25, 2026

<!--
Template:
**Working on**: [feature name]
**Touching**: [files / tables / migrations]
**ETA**: [done today / ongoing]
-->

---

_Clear your entry when you push and merge. If a session crashes mid-work, leave a note
so the other Claude knows the state._
