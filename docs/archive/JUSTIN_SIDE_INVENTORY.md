# Justin Side Inventory
**Produced by**: Justin's Claude Code session
**Date**: Apr 21, 2026
**Against**: `COMMAND_CENTER_MERGE_BRIEF.md` §3–§5

This document lists everything Justin's Claude has applied to the shared Supabase project
(`rcfaashkfpurkvtmsmeb`) and repo that is NOT already in Nathan's list of 27 migrations.
Each item has a keep / merge / rewrite / drop verdict and one-sentence rationale.

---

## 1 — Migrations

Justin's local migration files (vs Nathan's 27-migration list):

| File | Applied to DB | In Nathan's §3? | Verdict |
|---|---|---|---|
| `20260420000000_messages_outbound.sql` | ✅ Yes | ❌ No | **KEEP** |
| `20260420000001_phone_numbers.sql` | ✅ Yes | ❌ No | **KEEP** |
| `20260421000000_messages_direction.sql` | ✅ Yes | ❌ No | **KEEP** |

### Migration details

#### `20260420000000_messages_outbound` — KEEP
Creates a **new** `messages_outbound` table specifically for Twilio SMS traffic.

> ⚠️ **Important clarification for Nathan**: This is NOT the same as Nathan's `messages` table
> (migration 12, `messages_two_way_thread`). They serve completely different purposes:
> - `messages` (Nathan's) = in-app two-way threads between team ↔ client ↔ attorney
> - `messages_outbound` (Justin's) = Twilio SMS send/receive log with `twilio_sid`, `error_code`, `from_number`, etc.
>
> Nathan's brief §4.3 says "Plus `direction` column (Justin's recent add) for inbound/outbound SMS"
> on the `messages` table — this is **incorrect**. Justin's `direction` column is on
> `messages_outbound`, not `messages`. The two tables do not overlap.

Schema:
```
id, deal_id (FK→deals), to_number, from_number, body, status,
twilio_sid, error_code, error_message, sent_by (FK→auth.users),
created_at, updated_at
```

RLS policies (need convention rewrite — see §5 below):
- `sms_outbound_insert` — role IN ('admin','user','va')
- `sms_outbound_select_own` — sent_by = auth.uid()
- `sms_outbound_select_admin` — role = 'admin'

#### `20260420000001_phone_numbers` — KEEP
Creates `phone_numbers` table — a registry of Twilio numbers available for outbound SMS.
The `send-sms` Edge Function uses this to let the user choose which Twilio line to send from.

Schema:
```
id, label, number (unique), active (bool), created_at
```

RLS policies (need convention rewrite — see §5 below):
- `phone_numbers_select` — any authenticated user
- `phone_numbers_admin_write` — role = 'admin' (for all operations)

#### `20260421000000_messages_direction` — KEEP
Three changes in one migration:
1. `ALTER TABLE messages_outbound ADD COLUMN direction text NOT NULL DEFAULT 'outbound'`
2. `sms_inbound_select` RLS policy — all authenticated users can SELECT where direction = 'inbound'
   (needed because inbound rows have `sent_by = NULL`, so `select_own` never matches)
3. `find_deal_by_phone(phone_e164, phone_bare)` SECURITY DEFINER RPC — searches
   `deals.meta->>'homeownerPhone'` in both E.164 and bare format for inbound SMS routing

---

## 2 — Edge Functions

| Function | In Nathan's §5? | Verdict |
|---|---|---|
| `send-sms` | ✅ Listed | **KEEP** — no conflict, Nathan's side hasn't built this |
| `receive-sms` | ✅ Listed | **KEEP** — no conflict |
| `docket-webhook` | ✅ Listed | **KEEP** — shared, likely same code; verify versions match |

### Function details

#### `send-sms` — KEEP
- Deployed with `--no-verify-jwt` (required: project uses ES256 JWTs, gateway only validates HS256)
- Manually decodes JWT payload (base64url→base64 fix) to extract `user_id`
- Normalizes recipient number to E.164
- Resolves `from_number` against `phone_numbers` table (with active check)
- Inserts queued row to `messages_outbound` for optimistic UI, then calls Twilio API
- Updates row to `sent` or `failed` with error fields

Secrets required (set in Supabase dashboard → Edge Function secrets):
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_FROM_NUMBER` (fallback default)

#### `receive-sms` — KEEP
- Deployed with `--no-verify-jwt` (Twilio posts form-encoded data, no JWT)
- Twilio webhook URL configured on (513) 998-5440 number
- Parses `From`, `To`, `Body`, `MessageSid` from form-encoded POST
- Normalizes phones to E.164
- **Smart routing heuristic** (3-tier):
  1. Most recent outbound to that number → use that deal_id
  2. `find_deal_by_phone()` RPC → homeowner phone in deals.meta
  3. `vendors.phone` lookup
- Stores inbound with `direction='inbound'`, `to_number=contact's number`, `sent_by=NULL`
- Returns `<Response/>` TwiML (no auto-reply)

#### `docket-webhook` — VERIFY
Justin's repo has a `docket-webhook` source file. Nathan's side also owns this function.
**Action needed**: compare the two versions to confirm they are identical. If Justin's version
diverged, Nathan's is canonical (he built the full Castle integration). Justin likely just
stashed a copy in the repo for reference.

---

## 3 — New Tables

| Table | Not in Nathan's §4? | Verdict |
|---|---|---|
| `messages_outbound` | ✅ Correct — not in §4 | **KEEP** — add to §4.7 of merge brief |
| `phone_numbers` | ✅ Correct — not in §4 | **KEEP** — add to §4.7 of merge brief |

Both should be added to the canonical table inventory in §4.7 of the merge brief.

---

## 4 — New RPCs / Triggers / Views

| Name | Type | Verdict |
|---|---|---|
| `find_deal_by_phone(phone_e164, phone_bare)` | RPC (SECURITY DEFINER) | **KEEP** |
| `messages_outbound_updated_at` | Trigger (set_updated_at) | **KEEP** — uses same pattern as Nathan's `touch_updated_at` triggers |
| `public.set_updated_at()` | Function | **REWRITE** — Nathan may already have a `set_updated_at` or equivalent. Check for name collision. |

---

## 5 — Convention Violations to Fix

Nathan's §7 defines hard conventions. Justin's migrations violate two of them:

### 5.1 RLS helper functions not used
**Current (Justin's):**
```sql
(select role from public.profiles where id = auth.uid()) in ('admin', 'user', 'va')
```

**Should be (Nathan's convention):**
```sql
public.is_admin() OR public.is_va()
```

**Affected policies:**
- `sms_outbound_insert` on `messages_outbound`
- `sms_outbound_select_admin` on `messages_outbound`
- `phone_numbers_admin_write` on `phone_numbers`

**Verdict**: REWRITE — 3 policy updates needed. Low risk, purely cosmetic/convention.

### 5.2 `set_updated_at()` function may duplicate Nathan's equivalent
Justin's migration defines `public.set_updated_at()` as a trigger function.
Nathan's triggers use `touch_updated_at` (or similar). Need to verify no name collision.

**Action**: Nathan's Claude checks if `set_updated_at` or a functionally identical function
already exists in DB. If yes, drop Justin's version and point the trigger at Nathan's.

---

## 6 — HTML/React Components Added to `index.html`

| Component / Function | What it does | Verdict |
|---|---|---|
| `OutboundMessages` | SMS tab — full two-way thread UI with per-contact tabs, inbound bubble rendering, 6s polling, optimistic send | **KEEP** |
| `normalizePhone(p)` | Helper — strips non-digits, normalizes to E.164 `+1XXXXXXXXXX` | **KEEP** |

`OutboundMessages` renders when `tab === 'sms'` on deal detail. It is wired to `messages_outbound`
(not to Nathan's `messages` table). Nathan's `messages` table powers the separate in-app
Messages thread (a different tab). No overlap.

---

## 7 — Credentials Stored

| Secret | Location | Used by |
|---|---|---|
| `TWILIO_ACCOUNT_SID` | Supabase Edge Function secrets | `send-sms`, `receive-sms` |
| `TWILIO_AUTH_TOKEN` | Supabase Edge Function secrets | `send-sms`, `receive-sms` |
| `TWILIO_FROM_NUMBER` | Supabase Edge Function secrets | `send-sms` (fallback default) |

No credentials committed to git. No `.env` files on disk.

---

## 8 — Lauren pgvector (Migration 26 in Nathan's list)

Nathan's brief says migration 26 (`enable_pgvector_and_create_lauren_tables`) is
"Justin's work — already in DB." This is not in Justin's local migration files —
it was applied directly via Supabase SQL editor in an earlier session, not as a
tracked migration file.

**Justin's Claude should describe these tables** for Nathan's canonical §4 inventory.
From what was built: `lauren_*` tables for pgvector embeddings powering a chat widget
on refundlocators.com. Not yet wired into DCC portals. Exact schema needs a
`SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'lauren%'`
to confirm current state.

**Action needed**: Justin to query DB for exact lauren table schemas and document here.

---

## 9 — Known Conflicts Summary

| Conflict | Severity | Resolution |
|---|---|---|
| Nathan's brief incorrectly says `direction` column is on `messages` table — it's on `messages_outbound` | Low — documentation error only | Update §4.3 in merge brief |
| `set_updated_at()` function may already exist under a different name | Low | Nathan's Claude checks DB, drops duplicate if needed |
| 3 RLS policies use inline role checks instead of `is_admin()`/`is_va()` helpers | Low | Rewrite in a follow-up migration |
| `docket-webhook` exists on both sides | Low | Compare versions, confirm Nathan's is canonical |
| `lauren_*` tables applied via SQL editor, not tracked migration file | Medium | Add retroactive migration file for documentation |

---

## 10 — Items Justin Has NOT Built (Nathan Should NOT Expect)

To be explicit about what Justin's side has NOT touched:
- `messages` table (Nathan's) — untouched
- `client_access`, `attorney_assignments` — untouched
- `contacts`, `contact_deals` — untouched (Nathan built Phase 2 CRM)
- `docket_events`, `docket_events_unmatched`, `scrape_runs` — untouched
- `leads` table — untouched
- `portal.html`, `attorney-portal.html`, `lead-intake.html` — untouched by Justin's Claude
  (Nathan owns all three portals)
- All email triggers (`messages_email_notify`, `docket_events_client_notify`, daily digest) — untouched
- All role helper functions (`is_admin()`, `is_va()`, etc.) — untouched

---

## 11 — Recommended Follow-Up Migration

Once Nathan reviews and approves, Justin's Claude will write a single cleanup migration:

```sql
-- Patch Justin's SMS policies to use Nathan's is_admin()/is_va() helpers

ALTER POLICY "sms_outbound_insert" ON public.messages_outbound
  USING (public.is_admin() OR public.is_va());

ALTER POLICY "sms_outbound_select_admin" ON public.messages_outbound
  USING (public.is_admin());

ALTER POLICY "phone_numbers_admin_write" ON public.phone_numbers
  USING (public.is_admin()) WITH CHECK (public.is_admin());
```

Do NOT apply until Nathan confirms `is_admin()` / `is_va()` functions exist in the shared DB.

---

*End of Justin Side Inventory. Do NOT apply any merges based on this doc alone —
coordinate with Nathan's Claude first.*
