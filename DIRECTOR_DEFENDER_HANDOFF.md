# Director → DCC: Defender pre-sale workflow (2026-06-30)

From the **Main-Intel Director** session. Nathan directive 2026-06-30: turn the pre-sale
data we already scrape (NOD + complaint + decree + auction calendar) into a working
**Defender** lane inside DCC. RefundLocators (post-sale surplus) is unchanged; this adds a
parallel lane for Defender (pre-sale homeowner advocacy). Self-contained — act on it cold.

## The strategic frame (why this exists)

RefundLocators recovers surplus on the ~1-in-30 foreclosures that survive the sale with
money left over. The other 29 pass through our data 12–18 months earlier as
NOD → complaint → decree → scheduled auction — and today we drop them. Defender is the
brand for those homeowners (workout, short sale, cash offer, loan-mod / bankruptcy referral).
This handoff builds the **internal operator workflow** — the CRM / list / statuses / outcomes.

Full lifecycle context is in Nathan's `~/memory/project_defender_leverage_frame.md` (Director side).

## Existing data flow (unchanged)
```
ohio-intel gamma-1-nod-scan (88-county NOD scanner)
  → ohio_case (raw)
  → intel_case (graded)
  → intel_main (Director engine)
  → DCC (this handoff wires the pre-sale branch)
```

## What I'm handing you (Director-side — mine to build)

1. **New `intel_case.case_stage` values wired**: `NOD`, `COMPLAINT`, `DECREE`,
   `AUCTION_SCHEDULED`. Existing surplus stages stay as-is; this is additive.
2. **New computed field `intel_case.days_to_auction`** (int; null pre-decree).
3. **New pre-sale push branch** on the existing `push-to-dcc` cron —
   `deal_type='presale'` cases push through the same pipe as surplus.
4. **`deals.meta` fields I push** (mirroring the surplus contract, same
   camelCase + set-once conventions in `DIRECTOR_DCC_INTERFACE.md`):
   - `intelCaseId`, `intelMainUrl`, `county`, `courtCase`
   - `stage` (matches `case_stage` above)
   - `filedDate`, `decreeDate`, `saleDate` (as they land)
   - `plaintiffName`, `parcelId`
   - `equityEstimate` (Batch/IDI — already piped in via the research agent)
   - `openMortgageBalance`, `arv` (Batch fields)
   - `daysToAuction`
   - `lastIntelSyncAt` — SAME excluded-from-diff pattern as surplus (per the
     `DIRECTOR_PERF_HANDOFF` fix; do not include in change-detection)
5. **Timing signals** — stage transitions emit `intel_event` rows the docket-hook
   already reads. New event types: `presale_stage_advanced`, `presale_days_to_auction_threshold`.
6. **Pilot dataset first** — I trickle a small pilot (10 leads → 50 → full county) so we
   don't fill DCC with broken cards mid-build.

## What DCC builds (yours)

### 1. New deal type: `presale`
Per the DCC "add a new deal type" recipe in `CLAUDE.md`:
- Add `'presale'` to the deal-type union alongside `'flip'`/`'surplus'`/`'wholesale'`/etc.
- Deal-ID pattern: **`df-<lastname>`** (df = Defender). Mirrors `sf-` for surplus.
- Add to `DEAL_STATUSES` + `STATUS_COLORS`.
- Add a `DealCard` variant if layout differs; the "Situation Strip" below is the signature UI.

### 2. Statuses (`DEAL_STATUSES.presale`)
Left-to-right funnel:
| Status | Meaning |
|---|---|
| `new-lead` | Just imported from intel_main |
| `qualifying` | VA reviewing (equity check, contact enrichment) |
| `contacting` | Outreach started ⚠ **legal gate — see guardrail** |
| `active` | Homeowner engaged, working the situation |
| `awaiting-outcome` | Short-sale escrow / workout in flight |
| `won` | Recovered / referred to close (sub-outcome below) |
| `dead` | Didn't convert (reason below) |
| `handed-to-surplus` | Went to sale → RefundLocators lane picks up |

### 3. Outcome taxonomy (sub-reasons on `won` / `dead`)
`won` sub-outcomes (`meta.wonSubtype`):
- `short_sale_closed` (referral fee)
- `cash_offer_closed` (referral fee)
- `loan_mod_referred` (attorney referral fee)
- `bankruptcy_referred` (attorney referral fee)
- `wholesale_assigned` (internal — creates a `wholesale` deal)
- `flip_bought` (internal — creates a `flip` deal)

`dead` sub-outcomes (`meta.deadReason` — mirrors the surplus lead-outcome pattern):
- `no_equity` · `no_contact` · `refused_help` · `sold_before_intervention` · `bankruptcy_self_filed`

Both surface in a `v_defender_scoreboard` view I'll add (mirrors `v_qualification_scoreboard`
and `v_call_tracker`) so we can watch conversion.

### 4. The Situation Strip (Defender's signature UI)
Card face shows top-to-bottom:
1. Owner name + property address
2. **Situation Strip** — small stat row:
   - Stage badge + `days_to_auction` (or "past-due X mo" if pre-decree)
   - `equityEstimate` (or "unknown — needs skip trace")
   - `openMortgageBalance` / `arv`
3. Contact status pills: has phone? has address? been contacted? (existing pattern reused)
4. VA assignee

Card can share the shell with the surplus card; the strip is the differentiator.

### 5. Sidebar / nav — add "🛡 Defender" as a hub
Sibling to "🏠 Leads". Same shape:
- `defender-phase` — new + qualifying
- `defender-active` — contacting + active + awaiting
- `defender-archive` — won + dead
- `defender-pipeline` — kanban by stage

Update `LABELS.md` per the DCC convention.

### 6. Cross-brand handoff — the surplus transition
When a Defender case reaches `handed-to-surplus` (i.e. the property went to sale):
- Create a linked `surplus` deal `sf-<lastname>` from the Defender deal
- Preserve `intelCaseId`, contact history, notes, deal_notes, documents
- Original Defender deal stays with `status='handed-to-surplus'` as history
- The 30-min `sync-deal-updates` cron will keep BOTH deals in sync with `intel_case`

Suggest a small RPC `defender_handoff_to_surplus(deal_id)` so the transition is atomic +
auditable. UI wires a button; server does the clone + link.

### 7. Cross-deal awareness (life-of-file)
On the RefundLocators surplus card, show a badge: **"🛡 Prior Defender deal [df-smith]"**
when a preceding pre-sale deal exists (same `intelCaseId`, older `created_at`). Small touch,
big trust — shows the VAs the full arc of the homeowner.

## Data-model changes required

**Zero migrations.** Everything rides on existing structures:
- `deals.type = 'presale'` (new enum value; jsonb-friendly)
- `deals.meta` — new keys are all jsonb, no migration
- New status strings in `deals.status`

The stage-transition trigger can go on `deals` `AFTER UPDATE OF status` — same pattern as
`tg_sync_attorney_assignments_from_contact_deal` already does for attorney flow.

## Guardrails (Nathan's rules — read these)

### ⚠ Legal / compliance (the important one)
Outbound contact to homeowners **pre-foreclosure** has real regulatory edges:
- FTC MARS Rule (Mortgage Assistance Relief Services) — very specific disclosures required
- State-specific mortgage-assistance-relief laws (OH has one)
- TCPA (still applies)
- Cross-brand STOP registry (already implemented — respect it)

**This handoff builds the INTERNAL workflow only. Do NOT wire outbound comms to this lane
until Nathan clears it with counsel.** The `contacting` status can exist as an internal
marker before that clearance; the actual messaging just doesn't fire yet. The Situation
Strip, the Kanban, the outcomes tracking — all fine to build. The Send button for a
Defender-branded template stays disabled/hidden until the legal review lands.

### Brand boundary
Defender does pre-sale; RefundLocators does post-sale. **Client-facing copy from this lane
uses defenderha.com.** Nothing from this lane sends from RefundLocators or vice versa. The
internal DCC UI can share the shell — the outbound identity separates. Copy strings live
in `LABELS.md`.

### Justin separation
Nothing in this lane depends on Justin-owned infra. The comms layer (his domain) stays off
this lane until legal + separation resolve; even after legal clears, we may build outbound
on a Nathan-owned path (Twilio/Resend account under LLC control, not the bridge).

## Suggested build order (~1–2 focused sessions)

1. Add `presale` deal type + statuses + colors + LABELS.md
2. `DealCard` variant + Situation Strip
3. Sidebar "🛡 Defender" hub
4. Outcome sub-taxonomy (`meta.wonSubtype` / `meta.deadReason`)
5. `defender_handoff_to_surplus` RPC + button
6. Life-of-file badge on surplus cards
7. `v_defender_scoreboard` view

I'll wire the pre-sale push behind a feature-flag so DCC can build without live traffic;
we flip it on with a 10-lead pilot once your side is green.

## What's NOT in scope (yet — separate handoffs later)

- Client portal for Defender homeowners
- Any outbound comms (SMS / mail / voice) — legal clearance first
- Broker / attorney partner referral network + fee accounting
- Cross-brand attribution dashboard (after this lands, so the data exists)

## Acceptance criteria

- Creating a manual `df-test` deal renders correctly with the Situation Strip.
- Status transitions work and land in `deals.status` + `meta.wonSubtype`/`deadReason`.
- Kanban shows lanes; sidebar "🛡 Defender" hub navigates cleanly.
- `defender_handoff_to_surplus('df-x')` clones to `sf-x`, preserves history, links.
- Surplus card shows the "Prior Defender deal" badge when applicable.
- **Nothing on the RefundLocators / surplus lane changes.**
- **No outbound comms wired.**

## Coordination

- **My side, standing:** I hold pre-sale pushes until you flip a feature-flag on your end;
  no surprise traffic. Contract stays additive — no changes to the existing surplus fields
  in `DIRECTOR_DCC_INTERFACE.md`.
- **Your side:** please bump `DIRECTOR_DCC_INTERFACE.md` with the new managed `deals.meta`
  keys once you land the schema (`stage`, `equityEstimate`, `openMortgageBalance`, `arv`,
  `daysToAuction`).
- Ping the Director-Queue if anything's ambiguous. This is a big lane — happy to iterate
  on the shape in the ferry before you build if that helps.

**Bottom line:** RefundLocators keeps humming; Defender lights up as a parallel lane.
Same operator app, same data pipe — new revenue surface.
