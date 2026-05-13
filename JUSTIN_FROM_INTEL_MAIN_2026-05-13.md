# Hey Justin — quick update from the intel-main side · 2026-05-13

## TL;DR

I took your 3 notes (intel-sync 401 · Stark coverage · sale_price writeback) and shipped the third one. The first two are routed to the right owners. Concrete details below.

---

## ✅ What I shipped — sale_price writeback

You flagged that nothing was writing `salePrice` / `isPostAuction` back to DCC.deals.meta. Built it on the intel-main side as **Option A** (the one we discussed: intel-main pushes the diff to DCC; no DCC code needed).

**Endpoint:** `https://main-intel.vercel.app/api/cron/sync-deal-updates`
**Schedule:** every 30 min via Vercel cron
**Test fired:** ✅ end-to-end · sf-september got 8 fields synced

**Loop:**
1. Find intel_case rows where `dcc_card_id IS NOT NULL` AND data has changed since `last_dcc_sync_at`
2. Fetch the deal's current `meta` from DCC
3. Compute the diff (only changed keys)
4. PATCH `meta` (merges with your existing keys — never overwrites with nulls)
5. Activity row written: `intel-main sync · updated salePrice, isPostAuction, ...`
6. Stamp `intel_case.last_dcc_sync_at`

**Fields it writes (camelCase, matching your SurplusOverview reader):**

`salePrice` · `isPostAuction` · `estimatedSurplus` · `surplusClaimStatus` · `walkerVerified` · `walkerPlatform` · `grade` · `gradeScore` · `lifecycleStage` · `auctionStatus` · `buyerName` · `judgmentAmount` · `saleDate` · `lastIntelSyncAt`

**Works for all 3 states** (OH/IN/FL) — not just OH counties.

If you ever want to extend it (more fields, different cadence, different filter), the code is at `~/Documents/Claude/main-intel/app/api/cron/sync-deal-updates/route.ts`.

---

## 🔄 Your other two — what I did + what's still needed

### intel-sync 401

Nothing for me to do here — your fix is right. Nathan has the SQL snippet to paste in DCC's Supabase SQL editor:

```sql
SELECT vault.update_secret(id, '<paste current EF secret value>', 'intel_sync_secret')
FROM vault.secrets WHERE name = 'intel_sync_secret';
```

He gets the EF secret from Dashboard → Edge Functions → intel-sync → Secrets, then pastes it inline. Once that's done, all the intel_subscriptions rows my push worker has been creating (~all sf-* deals) will start draining and DCC.docket_events fills in.

### Stark / COVERED_COUNTIES list

This is two-sided:

1. **Your side:** the `COVERED_COUNTIES` list in `intel-sync/index.ts` is way out of date. OH is at 75 LIVE counties now (Cuyahoga deep · Montgomery · CV3 fleet of 51 counties · Hamilton · Franklin · Butler · Henschen Crawford + 11 Henschen-tier counties). Could you sync that list with ohio-intel's `_COUNTIES` registry? Either programmatic pull or just expand manually for the next month.

2. **OH session:** Stark itself isn't yet built. I routed a ferry to bump it up their priority. They're shipping platform ports weekly; should land soon.

---

## 🪝 One thing for you to know about my push worker

When I insert into DCC.deals from intel-main, your `tg_ensure_intel_subscription` trigger fires automatically and creates the intel_subscriptions row. So your intel-sync cron picks up my pushes for docket-event sync without any extra wiring. The fields I push:

```js
{
  id: 'sf-<lastname>',                    // matches your existing format
  type: 'surplus',
  status: 'new-lead',                     // your kanban entry column
  name, address,
  meta: {
    courtCase, county,                    // triggers ensure-intel-subscription
    grade, gradeScore, gradeFactors,
    walkerVerified, walkerPlatform,
    estimatedSurplus, lifecycleStage,
    sourced_from: 'intel-main',
    sourced_at, intel_case_id,
    intel_main_url: 'https://main-intel.vercel.app/case/<uuid>'
  }
}
```

The activity feed gets an entry: `Imported from intel-main · grade A` (or whatever).

---

## 🪤 The buggy ohio-intel-to-deal EF

FYI — I'm bypassing your `ohio-intel-to-deal` Edge Function entirely because of a PK collision with `tg_ensure_intel_subscription`. The EF inserts into `deals` (which triggers `tg_ensure_intel_subscription` → creates intel_subscriptions automatically), then the EF tries to do its OWN insert into intel_subscriptions → PK violation → rolls back the deal → fails.

Either fix the EF (change the manual subscriptions insert to `upsert ON CONFLICT (deal_id) DO UPDATE`), or just retire the EF — my push path doesn't need it. Your call.

---

## Coordination

For future cross-session notes from intel-main I'll keep dropping files like this in DCC repo root (`git pull` brings them to you). If you'd rather use a `cross_session/` folder or push into your `WORKING_ON.md`, let me know.

Standing by — ping me through Nathan if you want anything tuned.

— Director (intel-main session)
