# Revert Notes — Tab-Bar Consolidation (2026-04-23)

**Purpose:** if the condensed 6-tab deal-detail view feels worse than the old
11-tab version, this file tells you (or a future Claude session) exactly what
to revert. All underlying components are untouched, so rollback is a one-line
hash revert.

---

## Ships

| Stage | Commit | Description |
|---|---|---|
| 1 + 2 (bundled) | [`2302cd8`](https://github.com/TheLocatorOfFunds/deal-command-center/commit/2302cd8) | Tab bar: 11 → 6 (or 7 on admin flip). Merged Messages + SMS + Activity into Comms. Merged Vendors into Contacts. Merged Notes into Files. Hid Expenses on surplus. Moved Flag + Mark Bonus Due into ⋯ overflow menu. |
| 1 + 2 (orphan fix) | [`HEAD`](https://github.com/TheLocatorOfFunds/deal-command-center) | Fix one remaining `onJumpToTab('documents')` → `onJumpToTab('files')` in the Document Summary card. |

---

## What changed (high level)

| Before | After | Kept where? |
|---|---|---|
| **Tabs** Overview · Messages · Docket · Contacts · Expenses · Tasks · Vendors · Documents · Notes · Activity · SMS | Overview · 💬 Comms · Docket · Contacts · [Expenses on flip only] · Tasks · 📁 Files | — |
| SMS tab (OutboundMessages) | Inside Comms, top section | `OutboundMessages` component unchanged |
| Messages tab (MessagesTab) | Inside Comms, middle section | `MessagesTab` component unchanged |
| Activity tab (Activity component) | Inside Comms, bottom section | `Activity` component unchanged |
| Vendors tab (Vendors component) | Inside Contacts tab, lower section | `Vendors` component unchanged |
| Notes tab (Notes component) | Inside Files tab, lower section | `Notes` component unchanged |
| Documents tab (Documents component) | Is now the Files tab | Same component |
| Expenses tab (always visible) | Only visible on `deal.type === 'flip'` | `Expenses` component unchanged |
| Flag for Review + Mark Bonus Due buttons inline | Moved to ⋯ overflow menu; read-only pills shown when set | Same meta.flagged / meta.bonus_due fields |

## Backwards compatibility

`parseHash()` in [index.html](index.html) maps the retired tab slugs so old
bookmarks still resolve:

```js
if (tab === 'sms' || tab === 'activity') tab = 'comms';
if (tab === 'vendors') tab = 'contacts';
if (tab === 'notes') tab = 'files';
if (tab === 'documents') tab = 'files';
```

Safe to keep these mappings indefinitely.

---

## How to revert

### Fastest (recommended)
```bash
git revert 2302cd8      # reverts the bundled Stage 1+2 commit
# If the orphan-fix commit also needs reverting:
# git revert <orphan-fix-hash>
git push
```
GitHub Pages rebuilds in ~30s. Tab bar goes back to 11 tabs.

### Surgical (if you want to keep parts)

The commit touches **only `index.html`**. Four logical clumps inside it:

1. **Tab array + label rendering** (around line 3198–3210)
   ```diff
   -  const tabs = isAdmin ? (isFlip ? [..."comms", ..."files"] : [...]) : [...];
   +  const tabs = isAdmin
   +    ? ["overview", "messages", "docket", "contacts", "expenses", "tasks", "vendors", "documents", "notes", "activity", "sms"]
   +    : ["overview", "messages", "docket", "contacts", "tasks", "vendors", "documents", "notes", "activity", "sms"];
   ```
   Restore the two arrays. Restore the tab-label rendering:
   ```diff
   -  {id === "comms" ? "💬 Comms" : id === "files" ? "📁 Files" : id.charAt(0).toUpperCase() + id.slice(1)}{...}
   +  {id === "sms" ? "💬 SMS" : id.charAt(0).toUpperCase() + id.slice(1)}{id === "tasks" && tasksHigh > 0 ? " ●" : ""}
   ```

2. **Tab router** (around line 3298–3345) — replace the `{tab === "comms"}`, `{tab === "contacts"}`, and `{tab === "files"}` blocks with the original individual `{tab === "messages"}` / `{tab === "sms"}` / `{tab === "activity"}` / `{tab === "vendors"}` / `{tab === "notes"}` / `{tab === "documents"}` branches.

3. **Overflow menu** (around line 3264–3325) — delete the `<div style={{ position: "relative" }}>` overflow wrapper and the read-only Flag/Bonus pills. Restore the original two `<button>` declarations for Flag for Review + Mark Bonus Due.

4. **`parseHash` legacy remaps** (around line 408–418) — delete the five `if (tab === …)` lines.

5. **`showOverflow` state** (line 3139) — delete the `useState`.

None of these changes touched:
- Any DB migrations
- Any edge functions
- Any other component implementations
- Any RLS or security
- Any realtime subscriptions

So reverting is zero-risk.

---

## Why it was done

Deal-detail felt busy and noisy. [Discussion summary](#) of the audit:
- Messages + SMS + Activity all represented "humans talking about this case";
  splitting them was a migration accident not a design choice.
- Expenses had one row on most surplus deals (attorney fee — already shown
  in Financial Summary).
- Notes had ~9 total rows across the business.
- Vendors barely used on surplus; per-deal contacts concept is already served
  by `contacts` + `contact_deals`.
- Flag + Mark Bonus Due were visible but infrequently used; they hogged action
  bar real estate next to frequent actions (Client view, Counsel view, Post
  Update, Send Intro Text).

Stage 3 (not yet shipped) is the GHL-style continuous-thread Comms rebuild
that replaces the 3-stacked-section placeholder with a single filter-chipped
threaded view. See conversation context for the prior turn's recommendation.

---

*Leave this file in the repo. Future AI sessions + you both benefit from
knowing what the last-known-good reset looks like.*
