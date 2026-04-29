# Importing leads from GoHighLevel into the DCC

> **Audience:** Eric (running his own Claude Code session against this repo).
> **Goal:** Move surplus-fund leads out of GHL and into the DCC's `deals` + `contacts` + `contact_deals` tables, in a shape that makes the existing UI work with no extra cleanup.
>
> **Why this doc exists:** Nathan asked for "as simple as possible." Rather than a CSV uploader or a custom RPC, we wrote down the schema + classification rules so your Claude Code can do the inserts directly and you don't have to think about it.

---

## Tier classification (Nathan's rules)

Set `deals.lead_tier` based on the homeowner's estimated equity + whether they're alive:

| Estimated equity | Alive | Deceased |
|---|---|---|
| **≥ $100,000** | `A` | `B` |
| **< $100,000** | `C` | `C` |

(Tier C is anything under $100k, regardless of life status. Tier B = estate/probate cases — they take a different outreach approach because we're talking to family, not the homeowner.)

If the homeowner's life status is **unknown**, default to alive (`A` for ≥ $100k, `C` for <). You can always toggle them deceased later from the contact card → 🕊️ Deceased checkbox.

---

## What every lead becomes in the DCC

One GHL lead = **one deal** + **one contact (the homeowner)** + **one `contact_deals` link** between them.

### 1. The `deals` row

| Column | What goes here | Example |
|---|---|---|
| `id` | text PK. Pattern for surplus leads: `sf-<lastname>` (lowercase, no spaces). If duplicate, append a suffix: `sf-morrow-2`. | `sf-morrow` |
| `type` | Always `'surplus'` for these leads. | `surplus` |
| `status` | Always `'new-lead'` for fresh imports — they start in the lead pool. | `new-lead` |
| `name` | Homeowner full name (matches the contact). | `Charlotte Morrow` |
| `address` | Property street address (the foreclosed home). | `796 S Broadmoor Blvd, Springfield, OH 45504` |
| `lead_tier` | `A`, `B`, or `C` per the table above. | `A` |
| `meta` | jsonb. See below for required keys. | `{...}` |
| `owner_id` | Nullable for fresh imports. Will be assigned when someone takes the case. | `null` |

#### Required `meta` keys for surplus leads

```jsonc
{
  // canonical equity field — Tier calculation reads from here
  "estimatedSurplus": 110630,

  // foreclosure case context
  "county": "Clark",
  "courtCase": "23-CV-0836",         // case number from the docket
  "saleDate": "2025-01-23",          // ISO date when sheriff sold it
  "salePrice": 187600,               // what the home sold for
  "judgmentAmount": 85341,           // what was owed (debt + costs)

  // homeowner contact info — duplicated from contacts so the deal-overview
  // composer can text them without joining tables
  "homeownerName": "Charlotte Morrow",
  "homeownerPhone": "+19375614831",  // E.164 — leading + and country code

  // imported-from breadcrumb
  "source": "ghl-import",
  "ghl_lead_id": "<original GHL lead id, for traceability>"
}
```

If a value isn't known yet, **omit the key entirely** rather than passing `null` or empty string. The UI handles missing fields cleanly.

### 2. The `contacts` row (one per homeowner)

| Column | What goes here |
|---|---|
| `id` | uuid (let Postgres generate via `gen_random_uuid()` or omit and use the default) |
| `name` | Full name (same as `deals.name`) |
| `phone` | Primary phone in E.164. **If GHL has multiple phones, comma-separate them all in this one field** — the DCC splits them into per-phone tabs in Comms automatically. Example: `"+19375614831, +18432968664, +14407471377"` |
| `email` | Primary email |
| `kind` | `'homeowner'` for the foreclosed homeowner. |
| `tags` | text[] — at least include `'ghl-import'` so we can find these later. e.g. `'{ghl-import,clark-county,2026-04}'` |
| `notes` | Free text. Paste the full GHL note dump here — the existing UI will display it, and Claude can parse it later when generating outreach. |
| **`deceased`** | boolean. **TRUE** if GHL marked them deceased / obituary found / family contact says so. Drives Tier B classification. |
| `deceased_source` | text. If `deceased = true`, where did the info come from? `'GHL-import'`, `'obituary'`, `'family'`, `'skip-trace'`, etc. |
| `do_not_text` / `do_not_call` | booleans. Default false. Set TRUE if GHL has a DND flag on the lead. |

### 3. The `contact_deals` link (joins them)

```sql
insert into contact_deals (contact_id, deal_id, relationship, created_by)
values (
  '<contact uuid>',
  '<deal id>',
  'homeowner',
  '<your auth.uid()>'
);
```

`relationship = 'homeowner'` is critical — that's how the DCC's per-contact URL flow knows this contact is the homeowner and surfaces the homeowner URL on their tab instead of a relationship dropdown.

---

## Example: importing one lead end-to-end

For a lead like Charlotte Morrow (Clark County, $110,630 surplus, alive, multiple phones):

```sql
-- 1. Contact (the homeowner)
insert into contacts (id, name, phone, email, kind, tags, notes, deceased, deceased_source)
values (
  gen_random_uuid(),
  'Charlotte Morrow',
  '+19375614831, +18432968664, +14407471377',
  'canne1957@yahoo.com',
  'homeowner',
  '{ghl-import,clark-county}',
  'Imported from GHL on 2026-04-28. <paste full GHL notes here>',
  false,
  null
)
returning id;
-- → returns the new contact's uuid; capture it as :contact_id

-- 2. Deal
insert into deals (id, type, status, name, address, lead_tier, meta)
values (
  'sf-morrow',
  'surplus',
  'new-lead',
  'Charlotte Morrow',
  '796 S Broadmoor Blvd, Springfield, OH 45504',
  'A',
  '{
    "estimatedSurplus": 110630,
    "county": "Clark",
    "courtCase": "23-CV-0836",
    "saleDate": "2025-01-23",
    "salePrice": 187600,
    "judgmentAmount": 85341,
    "homeownerName": "Charlotte Morrow",
    "homeownerPhone": "+19375614831",
    "source": "ghl-import",
    "ghl_lead_id": "abc123"
  }'::jsonb
);

-- 3. Link them
insert into contact_deals (contact_id, deal_id, relationship)
values (:contact_id, 'sf-morrow', 'homeowner');
```

For a Tier B (deceased homeowner with high equity), change:
- `contacts.deceased = true`
- `contacts.deceased_source = 'GHL-import'`
- `deals.lead_tier = 'B'`

For a Tier C (anything <$100k), set `deals.lead_tier = 'C'`. Deceased status doesn't change tier when equity is below the threshold.

---

## Things to watch out for

- **Don't reuse a deal id.** If `sf-morrow` exists, your insert will fail. Either use `sf-morrow-2` or check first.
- **Phones must be E.164** (`+19375614831`, not `(937) 561-4831`). The Mac bridge + Twilio both reject anything else. If GHL has them formatted differently, normalize before insert. The DCC's `normalizePhone()` is a model: strip non-digits, prepend `+1` if 10 digits, prepend `+` if 11 digits starting with 1.
- **Multiple phones go in ONE `contacts.phone` field, comma-separated.** Don't create multiple contacts. The Comms UI splits them automatically.
- **Don't insert into `attorney_assignments`.** That table is auto-synced by a trigger when a `contacts.kind='attorney'` row is linked to a deal. For homeowner imports it's not relevant.
- **`activity` table is write-heavy.** If you're batch-importing 100s of leads, don't log every insert as an activity row — wait for outreach to start.
- **Tier B = different outreach voice.** Once a deal is Tier B, the team will text the family, not the homeowner. The downstream code reads `lead_tier='B'` OR `death_signal=true` as "estate case." Setting `deceased=true` on the contact + `lead_tier='B'` on the deal is enough.

---

## Verifying an import worked

After inserting a lead, you should be able to:

1. Open the DCC at `app.refundlocators.com`
2. Find the deal in **🧭 Pipeline → Tier A** (or B / C)
3. Click into the deal → **Comms** tab → see one tab per phone number
4. Click into the **Contacts** tab → see the homeowner card with the 🕊️ pill if deceased
5. From the deal overview → click "🔗 Generate personalized URL" → it mints `/s/<homeowner-slug>` automatically

If any of those don't work, the import was missing something — check the `meta` keys and the `contact_deals` link.

---

## Questions / extensions

- **GHL has skip-trace data with multiple address candidates.** Put the most likely one in `deals.address` and dump the rest in `contacts.notes`. Don't try to model this further yet.
- **Multiple contacts per deal (spouse, kids).** Insert a separate `contacts` row per person, then link each via `contact_deals` with `relationship='spouse'`/`'child'`/etc. The DCC will give each of them their own personalized URL via the per-contact UI.
- **GHL had this lead in a campaign already.** Don't import the campaign history — the DCC's outreach queue is different. Just bring the lead facts; let outreach restart from intro.

When in doubt, ask Nathan or check `CLAUDE.md` for the schema spec.
