Looking at transcript for session archive entry...

---
# Session 2026-04-28 — DCC Import + Team Messaging + Relationship URLs

**Owner:** Nathan
**Source JSONL:** <source>
**Status:** DRAFT (auto-generated backfill, needs review)

## What we set out to do
Multi-task session spanning Apr 28-29. Started with bug fixes from prior session (personalized URL bugs, phone column optional, deceased contacts). Escalated to bulk CSV lead importer for GHL → DCC migration, then team messaging overhaul (owner delete threads, EOD reports, Jitsi video, activity feed).

## Decisions made (durable — these change behavior going forward)
- **Per-contact personalized URLs**: Each contact on a deal (homeowner, child, spouse, parent, sibling) gets their own `/s/[token]` with relationship-aware copy. Slug pattern: `{ownerSlug}-{contactSlug}` (e.g. `/s/richardmikol-michelle`).
- **Deceased tracking**: `contacts.deceased` boolean + deceased_at/deceased_source fields. Tier B = deceased + ≥$100k equity. Deal name header color-codes: green=alive (Tier A), red+🕊️=deceased (Tier B), white=C/unset.
- **CSV importer with merge mode**: 📥 Import button (admin-only) ingests GHL exports. Auto-detects column mapping. Dedup on case#/address/phone with three decisions: skip/create/merge(audit). Merge mode backfills missing fields + family contacts on existing deals without overwriting populated data.
- **Family contacts**: GHL's "Family 1-10 Phone" columns import as separate contacts with relationship='other' + 'unlabeled-relationship' tag. New 🧹 Family Cleanup panel in deal Contacts tab for bulk relationship labeling.
- **Equity phase semantics**: `estimatedAvailableEquity` = pre-auction number (foreclosure still active). `estimatedSurplus` = post-auction (property sold). Tier determination uses whichever is populated.
- **Team messaging v2**: 
  - Owner-only 🗑 delete threads
  - 📋 EOD report modal (worked-on/blocked/next-up) saves to `eod_reports` table + auto-posts summary message
  - 👤 Activity feed per teammate (DM threads only) — pulls from existing `activity` table, grouped by day
  - 📹 Jitsi video calls (free) — opens `meet.jit.si/dcc-<thread-id>-<timestamp>` in new tab + posts join link
  - 🎥 Screen recording scaffold (`screen_recordings` table + storage bucket) — no UI yet, waiting for AI summarization budget
- **OWNER_EMAILS server-side enforcement**: RLS policy on `profiles UPDATE` checks `is_owner()` before allowing role changes. Client-only check was bypassable via SQL editor — now locked at DB layer.
- **Header consolidation**: 🔍 Search icon-only, ⚖ Docket badge-only, 📋 Leads badge-only (hidden if 0), 🤖 Lauren CC owner-only + badge-only. Library + Team buttons moved to ⋯ overflow menu. Lauren CC moved to Account Settings → 👑 Owner Tools.

## Gotchas hit (non-obvious; future sessions need to know)
- **Date TZ rollback on CSV import**: Using `new Date("May 05 2026")` shifts back a day in UTC+8 (Eric's timezone). Fixed by manual YYYY-MM-DD string parsing, skipping Date() entirely.
- **Family contact inserts failed silently**: Spreading `relationship` field into `contacts` insert (where it doesn't exist; only lives on `contact_deals`) caused Postgres to reject the row. The `if (fcErr) continue;` swallowed it — no error surfaced. Fix: stripped relationship from contacts insert.
- **NOT NULL constraint on booleans**: Postgres rejects explicit `null` even when column has `NOT NULL default false`. Must send `false`, not `null || null`.
- **deals.owner_id vs created_by**: Column is `owner_id` on deals; `created_by` lives on contact_deals + deal_notes. First import attempt wrote `created_by` on deals → every row rejected.
- **GitHub Pages deploy flake**: Build succeeded but deploy step failed (transient GitHub Actions issue). Empty commit retrigger fixed it. No code bug — just wait + retry.
- **Import insert order matters**: Original order (deal → contact → contact_deals) left orphan deals when contact insert failed. New order (contact → deal → contact_deals) cleans up on failure — no orphans possible.
- **Cache-busting vs URL query params**: `?fresh=mob1` doesn't bypass HTTP cache for assets (like app.js) — only the HTML. Hard-refresh (Cmd+Shift+R) required to see new deploys.

## Files / systems touched
- **Repo files:**
  - `src/app.jsx` (massive: ~2500 lines added across 20+ commits)
    - Per-contact URL mint + copy logic
    - CSV importer modal (full flow: drag-drop, auto-map, dedup, merge, preview, execute, result summary)
    - Family Cleanup panel
    - Case Details form expansion (every GHL CSV field)
    - Team messaging v2 (EOD modal, activity feed, Jitsi, owner delete)
    - Header reshuffle + ⋯ overflow menu
  - `src/app/s/[token]/copy.ts` (NEW) — relationship-aware copy templates (homeowner/spouse/child/parent/sibling/other)
  - `src/app/s/[token]/PersonalizedClient.tsx` — hero now full-viewport (100vh), empathy section, uses copyFor()
  - `src/app/s/[token]/opengraph-image.tsx` — uses copyFor() for dynamic OG images
  - `TRANSFER_TO_NEW_CLAUDE_CODE.md` — full refresh, Section 0 (recent changes log 2026-04-21→2026-04-29)
  - `WORKING_ON.md` — updated with Apr 29 session state
  - `docs/IMPORTING_LEADS_FROM_GHL.md` (NEW) — Eric's import guide

- **DB migrations:**
  - `20260428080000_personalized_links_per_contact.sql` — contact_id, relationship, partial unique index
  - `20260428080001_sync_trigger_contact_aware.sql` — split homeowner vs contact-row sync
  - `20260428090000_contacts_deceased.sql` — deceased/deceased_at/deceased_source
  - `20260428100000_profiles_phone_nullable.sql` — profiles.phone optional
  - `20260429120000_acknowledge_all_docket_events.sql` — `acknowledge_all_docket_events()` RPC
  - `20260429130000_owner_role_guard.sql` — `is_owner()` + `guard_profiles_role_change()` trigger
  - `20260429140000_team_messaging_v2.sql` — eod_reports + screen_recordings + storage bucket

- **Edge functions deployed:** None this session.

- **External systems:**
  - Vercel (refundlocators-next auto-deploys on push)
  - GitHub Pages (DCC deploys via Actions workflow — hit two flakes mid-session)
  - GitHub PAT (Nathan saved to `~/.gh-token`, configured git credential helper)

## Open follow-ups
- [ ] Apply outstanding migrations (deceased, owner_role_guard, team_messaging_v2) — SQL provided inline, not run by session end
- [ ] Re-merge B-leads CSV in audit mode to backfill family contacts (30 deals × ~5 family/each)
- [ ] C-leads CSV import (next batch)
- [ ] Phone-type detection (iPhone vs SMS vs landline) — parked per Nathan, needs Twilio Lookup API
- [ ] Cloudflare audit finish (Pages project inspection + restrict Maps API key) — 75% done, parked
- [ ] Lauren Control Center: aggregate refundlocators.com chat conversations + train on transcripts — separate build, ~half day
- [ ] Screen recording UI + AI summarization — scaffold exists, waiting for budget approval
- [ ] Prev/Next keyboard shortcuts (J/K nav like vim) — optional UX polish
- [ ]