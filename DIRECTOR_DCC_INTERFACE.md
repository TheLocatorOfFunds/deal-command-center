# Director ↔ DCC interface contract

**Last updated:** 2026-05-13 (Justin — Stop hook now per-worktree; see "Open coordination items" below)
**Living doc.** Either side updates as the contract evolves. Bump the date when you do.

## Domains

| Owns | Director (intel-main) | DCC (Justin) |
|---|---|---|
| Database | `intel-main` Supabase project (`qbdslghonhuvkacqlsbd`) | `DCC` Supabase project (`rcfaashkfpurkvtmsmeb`) |
| Core entity | `intel_case` (cross-state cases: OH/IN/FL) | `deals` (the working lead) |
| Scope | data + scrapers + audit + state coordination + grading + push gate | sales workflow + outreach + UI for Eric/Nam/Nathan/Justin |
| UI | `main-intel.vercel.app` (operator-internal) | `app.refundlocators.com` (team + clients + attorneys) |
| Out of scope | outreach, SMS, comms, deals workflow | scraping, case ingestion, walker pipelines |

## Tables intel-main writes to in DCC

| Table | When | What | Why |
|---|---|---|---|
| `deals` | Operator clicks "Push to DCC" + research-agent approves | INSERT new row with `type='surplus' status='new-lead'` + full meta + back-ref `meta.intel_case_id` | First push of a lead |
| `deals.meta` | Every 30 min via cron `sync-deal-updates` | UPDATE merging new fields when intel_case changes (salePrice, isPostAuction, surplusClaimStatus, walkerVerified, grade, lifecycleStage, etc.) | Keep DCC fresh as cases evolve |
| `activity` | On every push or sync | INSERT audit row like "Imported from intel-main · grade A" or "intel-main sync · updated salePrice, isPostAuction" | Audit trail |
| `intel_subscriptions` | Auto via DCC trigger `tg_ensure_intel_subscription` when deals.meta has courtCase+county | DCC's trigger; we don't write directly | Subscribes the case to DCC's intel-sync EF |

## Tables DCC writes to in intel-main

**Currently: none.** Phase 2B (planned) will add:

| Table | When | What | Why |
|---|---|---|---|
| `intel_event` (or callback to /api/dcc-callback) | When DCC `deals.status` changes to `signed` / `recovered` / `dead` | Send the change back as `dcc_card_won` / `dcc_card_lost` event | Close the conversion-learning loop |

This is **not yet built.** It's tracked in Director's Phase 2B queue. Justin: when ready, expose a webhook endpoint or post directly to intel-main's `intel_event` table via service-role.

## Cron jobs in play

| Cron | Owner | Schedule | What it does |
|---|---|---|---|
| `push-to-dcc` | intel-main (Vercel) | `*/5 * * * *` | Drains `intel_main.dcc_push_intent` queue → INSERTs new `deals` |
| `sync-deal-updates` | intel-main (Vercel) | `*/30 * * * *` | Detects intel_case diffs → PATCHes `deals.meta` |
| `intel-sync-30min` | DCC (pg_cron) | `0,30 * * * *` | Walks `intel_subscriptions` → pulls fresh docket events from ohio-intel into `DCC.docket_events` |
| `morning-sweep-daily` | DCC (pg_cron) | `0 12 * * *` UTC | Daily email digest to Nathan + Justin |

## Edge Functions we depend on each other for

| EF | Project | Owner | Status |
|---|---|---|---|
| `intel-sync` | DCC | Justin | ✅ live as of 2026-05-13 (rotated secret + set `verify_jwt = false`) |
| `ohio-intel-to-deal` | DCC | Justin | ⚠️ has trigger PK race; Director bypasses with direct insert. Either fix `ON CONFLICT (deal_id) DO UPDATE` on the subscriptions insert OR retire EF — Director's push path doesn't need it |
| `lauren-team-respond` | DCC | Justin | n/a to intel-main |

## Coordination protocol

**Daily/normal**: just work in your own domain. The interface above is stable.

**When changing the interface**:
1. Update this file with the change
2. Bump the date at top
3. Drop a message in the team-chat thread (`justin <-> nathan` or via Nathan-to-Director ferry)
4. The other agent updates their side within their next session

**Cross-session messaging**:
- Director → Justin: post to DCC `team_messages` thread `910f6a07` (justin <-> nathan) as Nathan
- Justin → Director: via Nathan, OR drop a file in `~/Documents/Claude/FundLocators-Vault/05-Operations/Director-Queue/` named `dcc-<short-title>.md`
- Both sides: this file (`DIRECTOR_DCC_INTERFACE.md`) is the canonical contract

## Open coordination items

- ⏳ DCC → intel-main feedback loop (won/lost events) — Director Phase 2B
- ⏳ `COVERED_COUNTIES` list in DCC's intel-sync EF needs to sync with ohio-intel's 75-county registry (Justin's task)
- ⏳ Stark County scraper — OH session work (Nathan ferries to OH session)
- ⏳ `ohio-intel-to-deal` EF PK race — Justin to fix OR retire (Director's path doesn't need it)
- ✅ 2026-05-13 (Justin) — **`WORKING_ON.md` structure changed: per-worktree subsections.**
  Each `## <Name>'s session` parent now contains one `### <Name> · <slug>` subsection
  per active worktree (slug = branch with `claude/` stripped). The Stop hook
  (`.claude/hooks/touch-working-on.sh`) reads/writes only the subsection matching
  the current worktree's branch. This eliminates the multi-worktree race that
  produced merge conflicts on PRs #152 / #153. **For Nathan / Director:** if a
  session inserts content into Nathan's section, target the existing
  `### Nathan · main` subsection (or create a new `### Nathan · <slug>` if you're
  on a non-main branch). `.claude/commands/catchup.md` (lands with PR #153) was
  updated in the same PR to read the new structure — if PR #153 lands first and
  the catchup.md edits aren't there, re-apply the two diff hunks under
  "Read `WORKING_ON.md`" and "Where I left off" from this PR.

## Naming + ID conventions

- Surplus deal IDs in DCC: `sf-<lastname-slug>` (existing convention). Director honors this when pushing.
- Flip deal IDs: `flip-<streetnumber>` (DCC convention).
- `meta.intel_case_id` is always the `intel_case.id` uuid (the back-reference).
- `meta.intel_main_url` is `https://main-intel.vercel.app/case/<intel_case_id>` (clickable from DCC).
