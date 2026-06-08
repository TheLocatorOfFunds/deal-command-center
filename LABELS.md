# LABELS.md — canonical UI label mapping

**This file is the source of truth for every user-facing label that
maps to a database value.** Web (`src/app.jsx`) and mobile (`mobile/`)
do not share a JS code path today (see #294 for the long-term shared/
JS dir plan). Until that lands, both surfaces look up labels by hand
against THIS file.

**Rule:** if you rename a label, update LABELS.md in the same commit,
update the matching label string in `src/app.jsx`, and update the
matching label string in `mobile/`. All three or none.

The DB column values (the left column of every table below) are NOT
changing. Only the user-facing strings.

Justin, 2026-06-08, verbatim: "I want the UI labeling to stay
consistent across web and mobile. We can't have different labels."

---

## 1. `deals.status` → canonical UI label

Status values live in `src/app.jsx` `DEAL_STATUSES` (line ~178) and
inform the chip / badge / status-bar labels on both surfaces.

### Flip type (`deals.type = 'flip'`)

| DB value | UI label | Tab placement | Notes |
|---|---|---|---|
| `lead` | New | New | Pre-contract, outreaching |
| `under-contract` | Under Contract | Deals | Active flip phase |
| `rehab` | Rehab | Deals | Active flip phase |
| `listing` | Listing | Deals | Active flip phase |
| `under-offer` | Under Offer | Deals | Active flip phase |
| `closed` | Closed | Closed | Real closed-and-paid flip |
| `dead` | (hidden) | Deleted | Killed lead or dropped deal |

### Surplus type (`deals.type = 'surplus'`)

| DB value | UI label | Tab placement | Notes |
|---|---|---|---|
| `new-lead` | New | New | Pre-contract, outreaching |
| `signed` | Signed | Deals | Retainer signed |
| `filed` | Filed | Deals | Claim filed |
| `probate` | Probate | Deals | In probate / heir track |
| `awaiting-distribution` | Awaiting Distribution | Deals | Court awaiting payment |
| `recovered` | Closed | Closed | Real closed-and-paid surplus (Phase 2: requires `meta.collectedAmount`) |
| `urgent` | Urgent | Deals | Surfaced separately on Attention view |
| `dead` | (hidden) | Deleted | Killed lead |

---

## 2. `deals.type` → canonical UI label

| DB value | UI label | Notes |
|---|---|---|
| `flip` | Flip | Real estate flip |
| `surplus` | Surplus | Foreclosure surplus funds case |
| `wholesale` | Wholesale | (Lightly used) |
| `rental` | Rental | (Lightly used) |
| `other` | Other | Catch-all |

---

## 3. Sidebar / nav structure (web `src/app.jsx`)

| Position | Icon | Label | Sub-views | Notes |
|---|---|---|---|---|
| 1 | 📌 | Today | (none) | Daily dashboard |
| 2 | 🎯 | Automations | outreach / inbox / leads / forecast | Hub |
| 3 | 💬 | Comms | communications / inbox | Hub |
| 4 | 🏠 | Leads | new / deals / closed / awaiting / deleted / pipeline | **Hub. Renamed from "Deals" 2026-06-08 (#290). See sub-tab table below.** |
| 5 | ✅ | Tasks | (none) | |
| 6 | 📞 | Follow-ups | (none) | |
| 7 | ⏱ | Time | (none) | Admin only |
| 8 | 📊 | Insights | reports / analytics / traffic | Admin hub |
| 9 | 💬 | Chat | (none) | Team chat |

### Sidebar entry #4 sub-tabs (the `🏠 Leads` hub)

Tab order: New → Deals → Closed → (⏳ Awaiting check) → Deleted → 🧭 Kanban.

| Order | Chip id | Label | DB filter | Notes |
|---|---|---|---|---|
| 1 | `leads-phase` | New | `status` in {`lead`, `new-lead`} | Pre-contract leads |
| 2 | `active` | Deals | Everything not in New, Closed, Awaiting, or Deleted | Active engaged work |
| 3 | `archive` | Closed | Flip: `status='closed'` or `'recovered'`. Surplus: `status='recovered'` AND `meta.collectedAmount > 0` | Real closed-and-paid only, NEVER dead, NEVER awaiting |
| 4 | `awaiting` | ⏳ Awaiting check | Surplus + `status='recovered'` + no `meta.collectedAmount` | **Transient.** Only renders when count > 0. Each row migrates to Closed once the check amount is entered via SurplusOverview "Recovery (post-close)" input (#297) |
| 5 | `deleted` | Deleted | `status='dead'` | Previously mislabeled into Closed for surplus (#292) |
| 6 | `pipeline` | 🧭 Kanban | (renders all non-closed/deleted) | Kanban view |

**Dropped tabs (do NOT re-add):**
- `flagged` (⚑ Flagged) — dropped 2026-06-08 per #290
- `hygiene` (🩺 Hygiene) — dropped 2026-06-08 per #290

---

## 4. Mobile nav (`mobile/`)

Mobile bottom-nav and screen labels must match the web Sidebar entry
#4 sub-tab structure above. The mobile bottom-nav "Leads" tab opens
into a screen with the same New / Deals / Closed / Deleted tab strip.

(Mobile session is the source of truth for mobile-specific
implementation paths. Add mobile file pointers here when the IA
rename lands on the mobile side.)

---

## 5. Operational notes

- **NO status enum changes.** All renames are UI-string-only. The
  underlying `deals.status` enum stays the same so analytics queries,
  RLS policies, and intel-main syncs (see `DIRECTOR_DCC_INTERFACE.md`)
  keep working.
- **Closed vs Deleted.** "Closed" means we got a check; "Deleted"
  means we walked away. Critical for surplus where the old "Closed"
  view was 138 rows but only 3 were real (#292).
- **Owner discipline.** Web changes in `src/app.jsx`, mobile changes
  in `mobile/`. If you rename one, rename both AND this file in the
  same PR.

---

## 6. Related issues

- #290 — IA rename (Deals → Leads, drop Flagged + Hygiene)
- #291 — `meta.collectedAmount` field
- #292 — Surplus Closed filter (Phase 1 + Phase 2)
- #293 — THIS FILE
- #294 — Future: shared/ JS dir (kill the manual-sync rule entirely)

Last updated: 2026-06-08
