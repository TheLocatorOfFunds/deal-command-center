# Director → DCC: performance hand-off (2026-06-23)

From the **Main-Intel Director** session to the **DCC** session. Nathan asked me to look at why
DCC feels slow from my side (I write into DCC via the push + 30-min sync). Here's what I found, what
I already fixed on my side, and the specific things in **your** lane that will help most. Self-contained
— act on it cold.

---

## 1. The big one — and it was mostly my fault (cause fixed on my side)

**`activity` is your heaviest table: 181,298 rows / 42 MB.** Of those, **~176k (97%) are my
intel-main sync** — and **175,102 are the single action `intel-main sync · updated lastIntelSyncAt`**
(~33k/week). My 30-min `sync-deal-updates` stamped a `lastIntelSyncAt` timestamp into `deals.meta`
every run and included it in change-detection, so every processed deal got re-written → your activity
trigger logged a row → the Team Activity feed filled with noise and the table ballooned.

**Fixed at the source** in main-intel `sync-deal-updates/route.ts` (commit `a019239`): `lastIntelSyncAt`
is now excluded from change-detection, so a deal is only written/logged when a **substantive** field
changes. (Pending deploy on the main-intel/Vercel side — Nathan's call; it only *reduces* DCC writes.)

### ✅ Immediate win for you: prune the junk rows (shrinks `activity` ~97%)
Delete ONLY the timestamp-only noise (NOT multi-field sync rows, which are real changes). Batched to
avoid a long lock:

```sql
-- Repeat until it reports 0 rows (≈18 batches for ~175k). Exact-match = noise only.
DELETE FROM activity
WHERE id IN (
  SELECT id FROM activity
  WHERE action = 'intel-main sync · updated lastIntelSyncAt'
  LIMIT 10000
);
-- when done:
VACUUM (ANALYZE) activity;
```
Keep rows like `intel-main sync · updated walkerVerified, lastIntelSyncAt` (921) — those reflect a real
field change. Optional: also prune `Imported from intel-main · grade ...` (198) if you don't want them.

---

## 2. Your lane — 542 performance advisories (Supabase `get_advisors` → performance)

These slow queries app-wide as tables grow (esp. `activity`, `docket_events`, `scrape_runs`). Run
`get_advisors({type:'performance'})` for the exact per-object list + remediation URLs. Summary + the
high-leverage fixes:

| count | issue | fix (highest ROI first) |
|---|---|---|
| **64** | `auth_rls_initplan` | Wrap `auth.uid()`/`auth.role()` in a subselect: `(select auth.uid())`. Evaluates **once per query** instead of once per row — biggest single win. |
| **83** | `unindexed_foreign_keys` | Add an index on each FK column. Speeds joins + cascade deletes. Prioritize FKs on the big tables (`activity.deal_id`, `docket_events.deal_id`, etc.). |
| **304** | `multiple_permissive_policies` | Consolidate overlapping permissive policies per (table, role, action) into one — each extra permissive policy is an extra check per query. |
| **87** | `unused_index` | Drop indexes with zero scans — faster writes, less bloat. |
| **3** | `duplicate_index` | Drop the dup of each pair. |

The `auth_rls_initplan` + `multiple_permissive_policies` fixes together usually give the most felt
speedup on a 4-tier RLS app like DCC. Re-run `get_advisors` after each migration to confirm they clear.

---

## 3. Other unbounded tables (confirm owner before pruning)
- `job_run_details` — 15,886 rows / 18 MB. pg_cron run history. Safe to age-out (keep ~14–30 days).
- `scrape_runs` — 34,962 rows / 15 MB. Castle/ohio-intel heartbeats (one row per county per run).
  Coordinate with that session before trimming; an age-out retention is fine.
- `_http_response` — 26 MB across only 84 rows (huge per-row bodies). Check what writes it; truncate
  stored bodies if not needed.
- `docket_events` — 3,216 dead tuples → `VACUUM` it.

---

## 4. Coordination — what I (Director) am doing / not doing
- **Doing:** holding off on big batch re-grades / mass writes from my side while you stabilize DCC, so
  I'm not adding write-load or feed-noise on top of your work.
- **Not doing:** I won't touch your RLS, indexes, schema, or the `activity` prune unless asked — that's
  your lane and we'd collide. The sync fix above is purely on the main-intel side.
- The DCC↔intel-main contract is unchanged; see `DIRECTOR_DCC_INTERFACE.md`.

**Net:** deploy my sync fix + run the activity prune = immediate relief (table shrinks ~97%, feed
de-noised). The 542 RLS/index advisories are the durable speedup, and they're yours.
