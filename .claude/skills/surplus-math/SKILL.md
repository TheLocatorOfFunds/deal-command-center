---
name: surplus-math
description: Parse a foreclosure Proposed Confirmation Entry PDF, calculate the surplus breakdown by adding every itemized distribution and subtracting from sale price, cross-reference with DCC deal meta + Director-known junior liens, output a structured math table plus a draft homeowner-facing text. Use when Nathan receives a Confirmation Entry or Proposed Distribution Order from any Ohio county and needs to (a) figure out if there's a surplus, (b) figure out how much, and (c) write the homeowner an honest update. Replaces the eyeball-the-PDF workflow that almost burned Joseph Beitko on 2026-05-28.
allowed-tools: Read, Bash, Grep
---

# Surplus disbursement math + homeowner text drafter

## Why this exists
On 2026-05-28 a draft "no surplus" text to Joseph Beitko was almost
sent — when in fact line (k) of the Stark County Confirmation Entry
left a blank balance of ~$27,944 pending further order. The error
would have permanently torched the relationship if he later saw the
disbursement.

This skill turns "stare at the PDF, eyeball the math, hope" into a
deterministic process: parse → compute → cross-reference → draft.

## Inputs
- `pdf_path` (required) — local path to the Confirmation Entry PDF
- `deal_id` (optional but strongly recommended) — DCC deal ID for
  cross-reference (e.g. `surplus-mo045b30948p`)

## Process

### 1. Read the PDF
Use the Read tool — it handles PDFs natively. Look for the standard
"IN THE COURT OF COMMON PLEAS / COUNTY, OHIO" caption and the
distribution list ("The distribution of the sale shall be completed
by [Title Agency] as follows, to:") which itemizes a-k.

### 2. Extract
- **Case caption:** plaintiff, defendant, court, judge, case number
- **Property:** address, parcel #
- **Sale:** date, purchaser, **sale price** (the "$X.XX for a total
  bid of $X.XX" line)
- **Distributions a-j:** every named line item with its dollar amount.
  Common items:
  - (a) County Clerk — court costs
  - (b) Plaintiff — publication costs
  - (c) Private Selling Officer — fees
  - (d) Title Agency — escrow/closing
  - (e) County Treasurer — taxes (current + pro-rated)
  - (f) Purchaser takes title subject to ... — NO dollar amount, this
    is a clause not a distribution
  - (g) Private Selling Officer — buyer's premium
  - (h) County Auditor — conveyance fee + transfer tax
  - (i) County Recorder — record deed
  - (j) Plaintiff — judgment satisfaction amount
- **Line (k):** "The balance of $______ to the Clerk of Courts to be
  held pending further order." If blank → flag it.
- **Exhibit B (liens to be released):** list each. Note: liens in
  Exhibit B may or may not appear in the (a)-(j) distribution list.
  A state tax lien or HOA lien might be paid from the balance, not
  itemized.

### 3. Compute
```
balance = sale_price - sum(distribution_amounts a-j, excluding f)
```
- If line (k) has a blank, this is the balance.
- If line (k) has a value, sanity check it against your computed
  balance.
- Subtract any Exhibit B liens NOT itemized in (a)-(j) — that's what
  typically eats the balance first.

### 4. Cross-reference DCC (if deal_id provided)
Run via the Chrome tab's `window.__dccClient`:
```js
const { data } = await sb.from('deals')
  .select('id, name, meta, refundlocators_token')
  .eq('id', '<deal_id>')
  .single();
const m = data.meta;
// extract: estimatedSurplus, feePct, attorneyFee, homeownerName, homeownerPhone
```
Compare:
- our `estimatedSurplus` vs computed balance
- our `feePct` (typically 20) vs what we'll actually charge

### 5. Compute net to homeowner
```
gross_surplus_to_homeowner = balance - exhibit_B_liens_not_yet_paid
attorney_fee = deal.meta.attorneyFee
fundlocators_fee = gross_surplus_to_homeowner * (deal.meta.feePct / 100)
net_to_homeowner = gross_surplus_to_homeowner - attorney_fee - fundlocators_fee
```

### 6. Identify the supplemental-claim risk
The "balance held pending further order" language means Plaintiff's
lawyers may still file a motion for supplemental distribution
(post-judgment interest, property-preservation advances, additional
attorney fees). For each Confirmation Entry, estimate the supplemental
risk:
- Low: judgment is recent, no large gap between judgment date and
  sale date, no signs of vacancy
- Medium: 6-12 months between judgment and sale
- High: > 12 months between judgment and sale, or property has been
  vacant (lender likely paid taxes/insurance)

## Output format

```
=== Surplus math: <Case #> ===
Property: <address>
Court: <county> County Common Pleas, Judge <name>
Sale: $<sale_price> to <purchaser>, <sale_date>

Distributions:
  (a) Clerk court costs ........... $X
  (b) Publication ................. $X
  (c) PSO fees .................... $X
  (d) Title ....................... $X
  (e) Treasurer (taxes) ........... $X
  (g) Buyer's premium ............. $X
  (h) Auditor ..................... $X
  (i) Recorder .................... $X
  (j) Plaintiff judgment .......... $X
  ─────────────────────────────────────
  Total distributions ............. $X

Balance (line k): $X.XX  ← <"per court entry" | "computed, blank in entry">

Exhibit B liens to be released:
  - <description>: $X (paid from balance? Y/N)

Surplus to homeowner (gross): $X.XX
Less attorney fee ($1,500 Kalniz / etc.): $X.XX
Less FundLocators 20% contingency: $X.XX
─────────────────────────────────────────
NET TO HOMEOWNER (best case): $X.XX

Supplemental-claim risk: LOW / MEDIUM / HIGH
  Reason: <date gap, vacancy signal, etc.>
  Worst-case net to homeowner: $X.XX (if plaintiff claims full balance)

DCC cross-reference:
  Our estimated_surplus at intake: $X
  Delta from actual: $X (over / under by Y%)
```

## Draft homeowner text

After the math, draft a text in Nathan's voice. Three templates
depending on outcome:

### Template A — Good news (positive net, low supplemental risk)
"Hey [homeowner], Nathan from FundLocators. The Stark County court
signed the Confirmation Entry on [date]. Sale was $X to [purchaser].
After the mortgage payoff ($X to [plaintiff]) and standard court/title
costs, there's approximately $X coming to you. Jeff Kalniz files the
motion for distribution next, and we'll get those funds released as
quickly as we can. After our attorney fee + 20% contingency, you'd net
~$X. I'll keep you posted as the motion lands."

### Template B — Uncertain (positive net, medium/high supplemental risk)
"Hey [homeowner], wanted to give you a status update on your case.
The court signed a proposed confirmation entry on [date]. There's a
remaining balance of ~$X being held by the Clerk pending further
order. [Plaintiff]'s attorneys may file to claim some of it for
post-judgment interest and fees — whatever they don't claim should
come back to you. Jeff Kalniz is tracking it. As soon as the
confirmation is officially finalized, he files the motion for
surplus distribution on your behalf."

### Template C — No surplus (only when math shows zero or negative)
**Stop. Re-verify the math.** Only generate this template if the
itemized distributions actually consume the full sale price OR a named
supplemental motion has already been granted that eats the balance.
Do not generate Template C on assumption.

## Anti-patterns to avoid
- "Line (k) is blank, so there's no surplus." (False. Blank means TBD.)
- "Plaintiff will probably take the rest." (Vague. Name the specific
  motion or don't claim it.)
- "Our estimate was $40k, actual is $20k → no surplus." (False. $20k
  IS a surplus.)
- "The HOA disbursement order shows $X to the association → that's the
  surplus / nothing's left." (False — Nathan 2026-06-09. An HOA /
  condo-association foreclosure or lien usually takes only a PARTIAL slice
  of the sale proceeds. Pull the **Sheriff's Report of Sale** (or the
  Confirmation Entry / Order of Distribution) to get the ORIGINAL sale
  price + full distribution — the balance beyond the HOA's slice may still
  be a large claimable surplus, especially when the senior mortgage was
  small or already paid off. The HOA order alone understates it.)
- Sending Template C without verifying the math sums to the sale price.

## Reference
- Joseph Beitko (`surplus-mo045b30948p`), 2025CV00945, Stark County,
  May 21 2026 entry: $246,410.80 sale - $218,467.11 distributions =
  $27,943.69 balance. Originally drafted Template C; corrected to
  Template B after this skill's math was checked.
- Roslyn Hurd (Cuyahoga, earlier 2026-05-27): $164,100 sale, surplus
  ~$115k by Director estimate, court-held balance $125,302.48 pending
  KeyBank's $16,552.62 supplemental motion. Net ≈ $108k expected.
