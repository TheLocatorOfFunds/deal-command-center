# Build brief — Lead-outcome feedback (the "why did this lead die" dropdown)

**From:** Director / intel-main session
**For:** DCC Claude (Nathan's session)
**Date:** 2026-05-26
**Size:** small — one dropdown on the existing "mark dead" path + 3 meta keys. No new tables, no sync code on your side.

## Why this exists (the one-paragraph version)

intel-main grades leads and pushes the good ones to DCC. Right now **90 of 315
surplus leads are marked `dead` and nothing records WHY.** So the Director can't
tell a lead that died because qualification was wrong ("already claimed", "no real
surplus") from one that was a perfectly good lead who just didn't sign. That
distinction is the gate for ever turning on **automatic** lead flow into DCC —
without it, auto-push would risk flooding callers with junk. This dropdown is the
missing signal. It's Step 1 of the auto-push path.

## What to build

When a user sets a **surplus** deal to `status='dead'`, require them to pick **one
reason** from a grouped dropdown, then store it on the deal's `meta`.

### Store these 3 keys on `deals.meta` (keep `status='dead'` as today)

| meta key | value | example |
|---|---|---|
| `dispositionReason` | one of the codes below (string) | `"already_claimed"` |
| `dispositionAt` | ISO timestamp of when they marked it | `"2026-05-26T15:04:00Z"` |
| `dispositionBy` | who marked it (profile id or name) — optional but nice | `"eric"` |

That's it. **Do not** build any sync — intel-main reads these keys back on its own
every 30 minutes (cron `sync-lead-outcomes`) and maps the reason to a category.

### The dropdown — exact codes, labels, and grouping

Show two groups so the caller's pick is intuitive. The **group is just UX** — the
Director derives the category from the code, so you only store the code.

**Group 1 — "Bad lead (shouldn't have been sent)"**
| code | label |
|---|---|
| `already_claimed` | Surplus already claimed / disbursed |
| `no_surplus` | No real surplus after debts/liens |
| `bad_data` | Wrong case / duplicate / bad data |
| `unworkable_estate` | Deceased — no heir/claimant findable |

**Group 2 — "Real lead, no deal"**
| code | label |
|---|---|
| `no_response` | Couldn't reach the homeowner |
| `declined` | Homeowner declined |
| `hired_competitor` | Signed with a competitor |
| `other` | Other |

(These reuse DCC's existing archive vocabulary — `bad_data`, `no_response`,
`hired_competitor` — on purpose, so both systems speak the same language.)

## Rules / gotchas

- **Required on dead, for surplus deals.** Don't let a surplus lead go `dead`
  without a reason — that's the whole point. (Flip and other deal types: your call;
  the Director only reads surplus.)
- **Editable.** If they picked wrong, let them change it — intel-main re-reads and
  corrects the scoreboard. Just update `dispositionReason` + bump `dispositionAt`.
- **Resurrecting a lead** (status off `dead`): you don't need to clear the keys —
  intel-main clears its own outcome record when it sees status is no longer dead.
- These 3 keys are **DCC-owned**; intel-main only ever *reads* them. They're the
  opposite of the intel-main-managed `meta` keys (grade, estimatedSurplus, etc.)
  that DCC must not touch. (Now documented in `DIRECTOR_DCC_INTERFACE.md`.)

## QA before you call it done

1. Open a surplus deal → mark it `dead` → dropdown appears, can't confirm without a pick.
2. Pick "Surplus already claimed / disbursed" → confirm `deals.meta.dispositionReason`
   = `"already_claimed"`, `dispositionAt` set.
3. Re-open, change to "Homeowner declined" → `dispositionReason` = `"declined"`,
   `dispositionAt` bumped.
4. (Optional) within ~45 min, ping the Director session — it'll confirm the reason
   showed up in `intel_case.outcome_reason` and on `v_qualification_scoreboard`.

## What the Director does with it

Builds `v_qualification_scoreboard` → bad-lead rate by grade + for the "safe slice"
(walker-confirmed + lien-researched + still-claimable). When that slice's bad-lead
rate is provably low, auto-push gets turned on for it first, capped. Steps 2–4 of
the path.
