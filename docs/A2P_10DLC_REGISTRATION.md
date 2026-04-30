# A2P 10DLC Registration — submission package + open gaps

This doc is the working file for registering FundLocators LLC's Twilio
number(s) under A2P 10DLC. It captures the audit results, the exact
text/screenshots to submit to The Campaign Registry (TCR), and the gaps
that have to be closed first.

**Status as of 2026-04-30:** Brand registration submitted (in TCR
review, 1-3 day wait). Campaign filing pending Brand approval. One
small website patch needed (HELP/STOP phone number — see §2).

---

## TL;DR — what to do, in order

1. **Patch the HELP/STOP phone number** on fundlocators.com — appears
   in two places (privacy policy AND the home-page form's consent
   checkbox label). Both currently say `+1 513-951-3014`; update to
   the real sending number. Detail in §2.
2. **Wait for Brand approval** in Twilio Console (1-3 days).
3. **File the Campaign registration** with the description, samples,
   and opt-in flow in §5.
4. **Wait 1-7 days** for Campaign approval; iterate on rejections
   using the gotchas list in §6.
5. **Port the GHL number** in parallel (separate flow — 7-10 days).

The TCPA caveat (§7) is the single most important thing to read before
submitting. It's a legal/operational issue, not a registration issue.

---

## §1 — Opt-in form audit (CORRECTED 2026-04-30)

**The opt-in form already exists on fundlocators.com homepage and is
properly built.** It contains everything TCR needs:

| Required element | Status |
|---|---|
| Phone number field labeled "Phone Number*" | ✅ Present |
| Unchecked-by-default SMS consent checkbox | ✅ Present |
| Consent label includes: opt-in language, STOP/HELP keywords, message frequency, msg & data rates, "we do not share or sell your data," links to Privacy Policy + Terms | ✅ All carrier-required clauses present |
| Form will not submit without consent checked | ✅ Verified (required attribute) |
| Submit button: "SEND MESSAGE" | ✅ |

**Whoever your agency is (Magnetix Agency per the footer) built that
form correctly.** No new HTML needs to be added.

The form lives in an iframe widget on the home page. That's why my
first audit erroneously reported "no forms" — `document.querySelectorAll`
doesn't traverse iframe contents from the parent document, and a static
fetch of the home page returns the shell, not the iframe payload.
**Future audit lesson:** when checking opt-in UX on a marketing site,
always inspect iframes and live-render the page, don't trust static
HTML or top-level DOM queries.

**The consent label as it currently reads on the form** (verified
2026-04-30):

> "I consent to receive SMS notifications, alerts, and communication
> from Fund Locators LLC. Message frequency varies. Message & data
> rates may apply. Text HELP to +1 513-951-3014 for support. Reply
> STOP to unsubscribe at any time. Information collected is used
> solely by Fund Locators LLC for direct communication regarding
> your property. We do not share or sell your data. Review our
> Privacy Policy and Terms and Conditions."

This passes carrier review **except for one issue:** the HELP number
`+1 513-951-3014` doesn't match the number we'll actually be sending
from. See §2 for the patch.

The previous draft of this doc recommended adding a checkbox to the
`refundlocators.com/s/{token}` claim modal. **That recommendation is
withdrawn** — fundlocators.com is the canonical opt-in URL for the
campaign because that's where the existing properly-built form lives.
The `/s/{token}` modal still has no checkbox, but it's not the
opt-in surface for the registered campaign — it's a follow-up tool
for already-contacted homeowners (see §7).

---

## §2 — Phone-number patch (TWO places on fundlocators.com)

**Audit finding:** the HELP/STOP number `+1 513-951-3014` appears in
two places on fundlocators.com that need to match each other and the
actual sending number:

1. **Privacy policy** at `/privacypolicy` — in the SMS consent clause
2. **Home-page consent checkbox label** — in the SMS consent text
   under the lead form

That number (951-3014) appears to be a leftover from an earlier GHL
configuration. The number we're actually keeping/porting is
**`+1 513-951-8855`** (the GHL number being ported to Twilio).

**Patch (apply in both places):**

Replace every occurrence of `+1 513-951-3014` with **`+1 513-951-8855`**.
That's it — one number, two locations.

**Why `+1 513-951-8855`:** that's the operational outreach number
that's been used through GHL for a while and is being ported to
Twilio. The `+1 513-998-5440` Twilio main is administrative; consumers
won't recognize it. Best to keep the HELP/STOP number on the recognized
public-facing line.

**Action:** Justin will give Claude access to the Magnetix Agency CMS
backend; Claude will make both edits, screenshot before/after, and
nothing else gets touched.

**Also confirm the rest of the SMS clause stays as-is** — the policy
already correctly contains:
- "By opting in, you consent to receive text messages, phone calls,
  and emails…" (consent)
- "No mobile information will be shared with third parties/affiliates
  for marketing/promotional purposes" (the carrier-required magic
  phrase — leave this exactly as written)
- "Message frequency may vary." (frequency)
- "Message and data rates may apply." (rates)

This patch needs to go in the fundlocators.com site repo, not this
repo.

---

## §3 — Terms-of-service SMS clause (optional, recommended)

**Audit finding:** `https://fundlocators.com/terms-and-conditions` has
zero SMS language. Not a hard blocker — TCR primarily reviews the
privacy policy — but if a reviewer asks for the Terms URL during
campaign review, it should at least mention messaging.

**Add this section to the Terms** (anywhere reasonable — usually near
the Communications / Notices section):

```markdown
## SMS / Text Messaging

By providing your mobile number to FundLocators LLC (dba RefundLocators)
through any FundLocators-operated form or channel, you agree to receive
recurring text messages and phone calls related to your case, including
status updates, document requests, and follow-ups from your case agent.
Message and data rates may apply. Message frequency varies based on
case activity. You can opt out at any time by replying STOP to any
message. Reply HELP for assistance, or contact us at
hello@fundlocators.com. Consent to receive messages is not a condition
of any service. Mobile information will not be shared with third
parties or affiliates for marketing or promotional purposes. See our
Privacy Policy for full details on how we handle mobile information.
```

This needs to go in the fundlocators.com site repo, not this repo.

---

## §4 — Brand Registration package

In Twilio Console: **Messaging → Regulatory Compliance → A2P 10DLC →
Brands → Create new Brand**.

| Field | Value |
|---|---|
| Brand type | Standard Brand (NOT Sole Proprietor — that's a separate flow) |
| Brand vetting | Yes — pay the ~$40 for Standard Vetting (gets you a vetting score; ≥75 unlocks higher throughput) |
| Legal entity name | **FundLocators LLC** |
| DBA / Brand display name | **RefundLocators** (this is what carriers show consumers; legal-name-vs-DBA gap is fine and expected) |
| Entity type | Limited Liability Company (LLC) |
| Country of registration | United States |
| Tax number type | EIN |
| EIN | _(fill from your tax docs — NOT in this repo)_ |
| Industry / Vertical | **Real Estate** (fallback: "Professional Services" if Real Estate gets pushback for surplus-recovery framing) |
| Stock symbol | (leave blank — private LLC) |
| Stock exchange | (leave blank) |
| Business address | 5054 State Road 252, Brookville, IN 47012 |
| Business phone | (the FundLocators Twilio number or your business line) |
| Website | `https://fundlocators.com` |
| Authorized representative — first name | Justin |
| Authorized representative — last name | Johnson |
| Authorized representative — title | Co-Founder |
| Authorized representative — email | justin@fundlocators.com |
| Authorized representative — mobile | (your direct mobile) |

**Cost:** ~$4 one-time + ~$10/year + ~$40 one-time vetting = ~$54
all-in.

**Approval timeline:** typically 1-3 business days.

---

## §5 — Campaign Registration package

**File this only AFTER §1, §2, and Brand approval are all done.**

In Twilio Console: **Messaging → A2P 10DLC → Campaigns → Create new
Campaign**.

### Use case selection

**Pick: Customer Care.**

Frame: "We notify property owners about funds they are already legally
owed from completed sheriff sales (public court record) and assist
with the recovery process. Communications are case-specific and 1-to-1."

Avoid "Marketing" — gets flagged for cold-outreach scrutiny. Avoid
"Lead Generation" — implies broad prospecting. "Mixed Use" is a fine
fallback if Customer Care gets rejected, but lower throughput.

### Campaign description (paste verbatim)

> FundLocators LLC (dba RefundLocators) sends one-to-one notifications
> to property owners regarding potentially recoverable surplus funds
> from completed sheriff sales of real estate, identified individually
> from public Ohio court records. Each message references the
> recipient's specific case (property address, county, case number).
> Messages include initial notification, follow-up case updates,
> document requests from our case agent, and procedural reminders
> tied to court deadlines. Recipients opt in via our personalized
> claim form at refundlocators.com/s/<token> by checking an SMS
> consent checkbox. They can opt out at any time by replying STOP.
> All messages are sent by a small team (2-5 senders) to identified
> individuals — never to broad lists or unverified numbers.

(Character count: ~775 — well over the 200 minimum, under most
ceilings. If a field caps shorter, trim from the front.)

### Sample messages (3 — each under 160 char where possible)

**Sample 1 — Initial notification (post-opt-in):**
> Hi Hannah — Nathan with RefundLocators. Records show the recent
> sale of your Fallis Rd property may have surplus funds owed to you.
> Reply Y for details or STOP to opt out.

**Sample 2 — Case follow-up:**
> Hi Hannah, quick follow-up on your Franklin County case — there's
> a deadline approaching. Full details: refundlocators.com/s/JsgBlTHV.
> Reply STOP to stop messages.

**Sample 3 — Document request:**
> Hi Hannah, your attorney needs one form signed to file the claim.
> I'll text the link in 2 min. Any questions reply here. STOP to opt
> out.

### Opt-in flow description (paste verbatim)

> Opt-in occurs on the FundLocators homepage at https://fundlocators.com,
> in the "Get Your Money Today" lead form. The form has four fields
> (Name, Phone Number, Email, "Tell us about your case") plus an
> unchecked SMS consent checkbox with the following label:
>
> "I consent to receive SMS notifications, alerts, and communication
> from Fund Locators LLC. Message frequency varies. Message & data
> rates may apply. Text HELP to +1 513-951-8855 for support. Reply
> STOP to unsubscribe at any time. Information collected is used
> solely by Fund Locators LLC for direct communication regarding
> your property. We do not share or sell your data. Review our
> Privacy Policy and Terms and Conditions."
>
> The form will not submit unless the checkbox is checked. After
> submission, our team contacts the user from the registered Twilio
> number within 24 hours regarding their property and any potentially
> recoverable surplus funds.

### Opt-in screenshot

Upload a desktop screenshot of the fundlocators.com home page lead
form **after §2's phone-number patch is shipped** (so the HELP number
shown matches the registered sending number). Capture the full form
with the consent checkbox visible and label legible. Recommended:
zoom to ~125% before screenshotting so the small print reads cleanly.

### Opt-in keywords
`START, YES, UNSTOP`

### Opt-out keywords
`STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT`

### Help keywords
`HELP, INFO, SUPPORT`

### Auto-reply messages

**Confirm opt-in (after START):**
> RefundLocators: You're subscribed to case updates from your case
> agent. Reply HELP for help, STOP to cancel. Msg&data rates may apply.

**Opt-out confirmation (after STOP):**
> RefundLocators: You're unsubscribed and won't receive further
> messages. Reply START to resubscribe.

**Help reply (after HELP):**
> RefundLocators (FundLocators LLC): For support call (513) 951-8855 or
> email hello@fundlocators.com. Reply STOP to opt out. Msg&data rates
> may apply.

### Privacy policy URL
`https://fundlocators.com/privacypolicy`

### Terms URL
`https://fundlocators.com/terms-and-conditions`

### Embedded link / phone number
- Embedded link: `Yes` (we link `refundlocators.com/s/<token>` URLs in case follow-ups)
- Embedded phone number: `Yes` (HELP replies include `(513) 951-8855`)

### Affiliate marketing
`No` (don't check this even though tempting — affiliate flag triggers
extra scrutiny and we don't actually have affiliates)

### Age-gated content
`No`

### Direct lending / loans
`No` (we recover money owed, we don't lend)

### Number pool
- `+1 513-998-5440` (FundLocators Main Twilio — already on account, available immediately for the campaign while the port is in flight)
- `+1 513-951-8855` (currently on GHL — assign to this campaign once the port lands ~7-10 days)

---

## §6 — Common rejection reasons + how to respond

| Rejection reason | Likely cause | Fix |
|---|---|---|
| "Privacy policy missing required mobile information clause" | Carriers grep for "mobile information will not be shared" | Already present in fundlocators.com policy — verify the exact phrase wasn't accidentally edited |
| "Opt-in flow does not constitute express written consent" | Pre-checked checkbox, no checkbox at all, or vague language | The fundlocators.com form already passes (unchecked, required, full clauses). Verify nothing has been edited recently. |
| "Sample messages do not match opt-in flow" | Sample says "Hi {firstname}" — fundlocators.com form does capture Name, so this should pass. Could fail if samples reference fields the form doesn't capture. | Cross-check sample placeholders against form field names |
| "Use case mismatch — appears to be Marketing not Customer Care" | Description sounded promotional | Re-emphasize "money already owed", "1-to-1", "case-specific". Strip any "save money", "claim your", marketing-y language |
| "Brand DBA mismatch with website" | Submitting RefundLocators as DBA but website is fundlocators.com | This is fine — the policy/terms cite both entities — but be ready to attest in writing |
| "Sample messages must include opt-out language" | Carriers want STOP / opt-out language in initial messages, not just buried in auto-reply | Already in our samples — verify before submit |

If rejected, you have a free chance to revise and resubmit. Don't
panic on first rejection — it's normal.

---

## §7 — TCPA caveat (read this before submitting)

A2P 10DLC compliance is **not the same as** TCPA compliance.

- **TCPA requires prior express written consent** before sending
  marketing/lead-gen SMS to a US mobile number. Statutory damages:
  $500-$1,500 per text. Litigation farms exist for exactly this.
- Cold-texting homeowners scraped from county auction records — even
  with HELP/STOP keywords and a privacy policy — **is a TCPA
  violation** if they never opted in. The current iMessage bridge
  flow (P2P-shaped, signed from Nathan's named phone) is a gray
  area but lower volume.
- **Once you register A2P,** you're declaring yourself a business
  sender. Carriers AND TCPA plaintiffs both hold registered senders
  to a higher standard.

**The clean operational split:**

| Cohort | How they got there | Channel |
|---|---|---|
| **Warm — opted in via fundlocators.com home form** | Filled "Get Your Money Today" form, checked the SMS consent box | **Twilio A2P (the registered campaign)** |
| **Cold — auction-discovered, not yet responded** | Castle's sweep matched their name from public records | **Mac bridge / iMessage from Nathan's phone** (current flow). Don't scale this 10x. The `/s/{token}` claim modal on refundlocators.com is a follow-up tool for this cohort — it's not an opt-in surface and doesn't have a consent checkbox. Don't pretend otherwise. |

If you commingle (send cold leads through the registered Twilio
campaign), you're at TCPA risk on every text. **Strongly recommend
running this past a TCPA-aware attorney before pushing send on
the registered campaign with anyone outside the warm cohort.**

This is operational guidance, not legal advice. I'm not your lawyer.

---

## §8 — Acceptance checklist

Before clicking "Submit Campaign", verify all of these:

- [x] §1 — Opt-in form already exists on fundlocators.com homepage with all required clauses (verified 2026-04-30)
- [ ] §2 — HELP/STOP number patched on fundlocators.com (privacy policy AND form checkbox label) from `513-951-3014` to `513-951-8855`
- [ ] §1 — Screenshot taken of fundlocators.com home form with consent checkbox visible AFTER §2 patch lands
- [ ] §3 — Terms SMS clause added (optional but recommended)
- [x] §4 — Brand registration submitted (in TCR review as of 2026-04-30, ~$4.50 charged)
- [ ] §4 — Brand approval received from TCR (1-3 day wait)
- [ ] EIN, authorized rep details, mobile number all in hand (✅ captured during Twilio upgrade KYC)
- [ ] §7 — TCPA caveat understood; cold-vs-warm channel split confirmed

Once submitted, monitor Twilio Console daily until the campaign moves
from "Submitted" → "In Review" → "Approved". Any rejection comes back
with a reason; iterate via §6.
