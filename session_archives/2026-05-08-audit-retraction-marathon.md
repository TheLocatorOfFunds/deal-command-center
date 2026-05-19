# Session 2026-05-08 — Audit + retraction marathon (8 migrations, 4 architectural drift fixes)

**Owner:** Nathan
**Branch(es):** main (DCC) · `nathan/lauren-returning-visitor-memory` (refundlocators-next, view-tracking commit awaiting merge) · `fix/judgment-drain-oom` (ohio-intel)
**Related PRs:** All DCC commits merged to main (dfd9d57 → 8638bd2, ~10 commits). Ohio Intel branch open for review.

## What we set out to do

Eric flagged the "Charlotte Morrow missing: phone" warning as not just cosmetic — Charlotte was Mark Prepped but never entered the outreach drafts queue. Hunting that bug surfaced a deeper architectural pattern (contact data ↔ deal data drift), then triggered an audit of the whole funnel + fixes for every silent-failure pattern found, then a retrospective + 7-day report + tonight's Castle health investigation.

## Decisions made (durable — these change behavior going forward)

- **Single source-of-truth model: contacts table** owns homeowner facts (phone, deceased, kind). `deal.meta` is a denormalized cache that's auto-synced via DB triggers. We hit this 4 times in one day:
  - `meta.homeownerPhone` was narrow + drifted → `dealMetaPhone()` helper accepts 4 key variants + sync trigger from contact phone
  - `meta.deceased` didn't reflect contact-level deceased flag → sync trigger
  - `contact_deals.relationship` was NULL on 247/406 rows; UI papered over via `contacts.kind` → backfilled
  - `personalized_links.phone` was NULL on homeowner URLs → next migration to ship (4th instance, deferred to "tomorrow's fix")
- **Soft-delete reason codes** (`sale_unwound | judgment_paid_pre_sale | owner_reinstated | duplicate | data_error | bankruptcy_filed | no_surplus | other`) live on `deals.deleted_at + deleted_reason + deleted_by`. Distinct from status='dead' which means "we worked it didn't pan out." Soft-delete = "this lead shouldn't have entered the system at all."
- **Stale-queue sweeper** runs daily at 09:00 UTC via pg_cron, cancels any `outreach_queue` row stuck in queued/pending/generating > 14 days with `skipped_reason='stale — auto-cancelled by daily sweep'`. Closes the zombie-row leak.
- **Third notification leg: # Ops chat** for both claim submissions (via `personalized_links.claim_submitted_at` trigger) and Lauren alerts (via `lauren_alerts` insert trigger). Posts as `team_messages.sender_kind='system'` (new value). Realtime broadcast means every open DCC client sees alerts even if Twilio + Resend silently fail.
- **Per-view audit on personalized_links** distinguishes real engagement from team testing. New `personalized_link_views` table captures IP + user-agent + referer per page hit; `v_personalized_link_engagement` view exposes `distinct_external_fingerprints`. The `view_count` integer alone is meaningless for engagement signals — was the source of two false-positive "HOT lead" claims today.
- **C-tier prepped leads need a manual queue path.** Auto-queue is A/B-only by design; C-tier sit in Ready forever otherwise. Shipped admin-only "🚀 Queue outreach · N C" button on Pipeline → Kanban next to the A/B button. Eric's C-tier prep work isn't wasted.
- **Verify before claiming.** Today's session retracted 5+ unverified claims after Eric pushed back. Pattern: declaring "code shipped" or "SQL ran" as if equivalent to "user-observed behavior matches claim." Going forward: don't call something "live" until something downstream of the code change confirms it (a screenshot, a returned row, a real test).

## Gotchas hit (non-obvious; future sessions need to know)

- **`team_messages.sender_kind` constraint** previously was `('admin','va','lauren')` only. New value `'system'` for the # Ops alert leg required updating the CHECK constraint. Migration `20260508180000_post_alerts_to_ops_chat.sql`.
- **`team_threads` lookup by title='Ops'** is brittle long-term but works because the Ops thread is the seed-created channel. New helper `public.get_ops_thread_id()` returns NULL gracefully if missing/archived; trigger fail-quiet so chat post never breaks the parent flow.
- **`castle_health_log.email_sent: false`** for 5 days running was the actual broken thing; the AI summary mentioning butler+montgomery as "chronic" was reading correct data. My initial "all 93 agents marked unknown" diagnostic was a typo bug in my JS probe (read `a.health` instead of `a.health_color`). The classifier was always working. The email path is the part that's actually dead.
- **`ohio-intel-judgment-drain` OOM-killed** on the 1.9 GB intel-vps because `subprocess.run(..., capture_output=True)` buffers the FULL stdout+stderr of every Selenium child in parent RAM. Fixed on branch `fix/judgment-drain-oom` — temp files instead of in-memory buffers. Timer was auto-disabled when service hit oom-kill; re-enabled it via SSH this evening.
- **`contacts.do_not_text` boolean is the auto-queue gate, NOT contact.notes.** Eric's IDI Core notes flagged Richard Mikol's contacts as "DND for SMS" in the free-text notes field, but the structured `do_not_text` column was false on all of them. The auto-queue gate reads the column, so Richard slipped past despite Eric's clear notation. Going forward: when Eric flags DND in notes, also flip the boolean.
- **Per-view audit table is forward-only** — won't backfill the 39+ existing views on Richard. Pre-2026-05-08 view counts on personalized_links remain ambiguous (could be real engagement, team testing, or test-claim submissions). The engagement strip surfaces them as "legacy views (pre-audit, source unknown)" so we don't conflate them with new tracked views.
- **chrome MCP tab is stateful** and dies if the user closes the tab. Resume requires `tabs_context_mcp` to find new tabs or have user reopen DCC. Several probes mid-session hit this.
- **The CLAUDE.md SSH alias `defender-mini`** doesn't resolve from this repo's box — Castle/Ohio Intel scrapers actually run on `intel-vps` (key at `~/.ssh/castle_vps`). The recommendation text from `castle_health_log` saying "restart on the Mac Mini" was AI-generated from incomplete context.

## Files / systems touched

- **Repo files (DCC):**
  - `src/app.jsx` — `dealMetaPhone()` helper, `isDeceased()` helper, `DeceasedBadge` component, `EngagementStrip` component, `DeleteDealModal` + `DeletedLeadsModal`, dup-check on NewDealModal, `BulkOutreachButton` parameterized for C-tier admin button, etc.
  - `WORKING_ON.md` — full Nathan section rewrite (was last updated 2026-05-01, now reflects entire week)

- **Repo files (refundlocators-next, on `nathan/lauren-returning-visitor-memory` branch):**
  - `src/app/s/[token]/page.tsx` — per-view IP + user-agent capture into `personalized_link_views`. Awaits merge to main + Vercel deploy.

- **Repo files (ohio-intel, on `fix/judgment-drain-oom` branch):**
  - `intel/run_judgment_drain_isolated.py` — subprocess output redirected to temp files instead of `capture_output=True` to prevent parent OOM.

- **DB migrations (8 applied today, all in `supabase/migrations/`):**
  - `20260508130000_team_threads_dm_privacy_fix.sql` — RLS now scopes by participants list (any thread with participants → only those participants read it). Backfilled 247 NULL `contact_deals.relationship` from `contacts.kind`.
  - `20260508140000_backfill_ghl_family_relationship.sql` — historical GHL family-contacts moved from relationship='other' to 'family'.
  - `20260508150000_homeowner_phone_sync.sql` — sync triggers contact phone → `deal.meta.homeownerPhone`. Backfilled 6 deals (incl. Charlotte/Richard/Trevor) + retroactively queued the 3 prepped A-tier silently-skipped leads.
  - `20260508160000_audit_remediation.sql` — cancelled 2 deceased-homeowner outreach rows + 1 zombie pending row; backfilled 24 deals where contact-says-deceased but deal didn't; deceased sync triggers; `sweep_stale_outreach_queue()` + pg_cron daily 09:00 UTC; deleted 20 orphan personalized_links (incl. Nathan's 4/26 manual-test row).
  - `20260508170000_personalized_link_views.sql` — per-view audit table + `v_personalized_link_engagement` view.
  - `20260508180000_post_alerts_to_ops_chat.sql` — `team_messages.sender_kind` allows 'system'; triggers post claim submissions + Lauren alerts to # Ops.

- **Edge functions deployed:** None (all changes were SQL triggers that don't need EF deploy). The `notify-claim-submitted` and `lauren-event-router` EFs are unchanged; tonight's chat-leg fires from a new SQL trigger that runs alongside the existing http_post triggers.

- **External systems:**
  - intel-vps (deploy@): `ohio-intel-judgment-drain.timer` re-enabled (was auto-disabled on oom-kill); failed state reset on the service.
  - Supabase project rcfaashkfpurkvtmsmeb: 8 migrations applied via SQL editor.

## Open follow-ups (carries forward to a future session)

- [ ] **Send the first real outbound SMS** — 73 prepped, 22 queued, 4 actually sent in 7 days. The whole funnel points at a Send button that hasn't been clicked at scale. This is the actual launch, not the kanban or the URL minter.
- [ ] **Bump Inaam to admin role** — SQL drafted in tonight's transcript. He's blocked from prep work because surplus fields are hidden at VA role. Eric's SOP for him is delivered.
- [ ] **Cherry-pick portal commit `97c4747`** from `nathan/lauren-returning-visitor-memory` to main on refundlocators-next — view tracking only populates after the portal page deploys.
- [ ] **Set `TEAM_VIEW_IPS` env var in Vercel** (CSV of team IPs) — without it, team views land in `personalized_link_views` without `is_team_view=true` flag, so the engagement view's "external" filter is too generous.
- [ ] **Merge or close `fix/judgment-drain-oom`** ohio-intel branch + `git pull` on intel-vps + restart timer. Or just let next 6h fire test the patch.
- [ ] **Investigate the Resend/`RESEND_API_KEY` env** on `castle-health-daily` Edge Function — the most likely cause of `email_sent=false` for 5+ days. Check at https://supabase.com/dashboard/project/rcfaashkfpurkvtmsmeb/functions/castle-health-daily/secrets.
- [ ] **GHL family-contact orphans (118 rows)** from 4-29 + 5-1 imports — re-link by name pattern (preserves $177 IDI Core spend) or wipe + re-import. Decision deferred.
- [ ] **Smoke-test the # Ops claim alert chain** — submit a fake claim on an inactive token in incognito, watch # Ops for the system post. Verifies tonight's wiring without real-client impact.
- [ ] **`personalized_links.phone` sync trigger** — 4th instance of the contact↔deal-data drift pattern. Charlotte/Trevor's homeowner URLs have phone=NULL even though their contact records have phones, so the Outreach → Leads view's `WHERE phone IS NOT NULL` filter hides them. Same fix pattern as `meta.homeownerPhone` — sync from contact_deals.relationship='homeowner' contact's phone.
- [ ] **`contacts.do_not_text` should auto-flip** when "DND" appears in the contact's notes field. Eric flagged Richard's three phone numbers as "DND for SMS" in IDI Core notes; structured column stayed false; auto-queue gate didn't see it.
- [ ] **4 _pending_review/ migrations** still parked: `client_edit_requests`, `research_shadow_log`, `research_rejections`, `agent_room_actions`. Each waits on its consumer to go live (client portal correction-request UI, research-agent Phase 1 shadow run, agent-room daemon deploy). Decide-or-delete eventually.
- [ ] **Castle butler + montgomery agents** flagged "chronic" in `castle_health_log` — confirmed today the systemd services are healthy (exit 0/SUCCESS every 30 min). The "chronic" alert is about run-internal failures (CourtView 3 session timeout / Selenium reCAPTCHA), not the daemon dying. Real ops fix is to investigate why those specific scrapers hit their internal error rates, not a restart.
