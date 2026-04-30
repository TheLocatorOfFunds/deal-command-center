# A2P 10DLC Registration — submission package + open gaps

This doc is the working file for registering FundLocators LLC's Twilio
number(s) under A2P 10DLC. It captures the audit results, the exact
text/screenshots to submit to The Campaign Registry (TCR), and the gaps
that have to be closed first.

**Status as of 2026-04-30:** Not yet submitted. Three site-side gaps
must be closed before submission (see "Pre-flight gaps" below).

---

## TL;DR — what to do, in order

1. **Add an SMS consent checkbox** to the `/s/{token}` claim modal (on the marketing site repo, not this repo). Copy in §1.
2. **Patch fundlocators.com privacy policy** — fix the HELP/STOP phone number to match the actual sending number. Patch in §2.
3. **Add SMS clauses to fundlocators.com Terms** (optional but improves approval odds). Patch in §3.
4. **File the Brand registration** in Twilio Console with the values in §4.
5. **File the Campaign registration** with the description, samples, and opt-in flow in §5.
6. **Wait 1-7 days** for approval; iterate on rejections using the gotchas list in §6.

The TCPA caveat (§7) is the single most important thing to read before
submitting. It's a legal/operational issue, not a registration issue.

---

## §1 — Claim modal consent checkbox

**Audit finding:** the `/s/{token}` claim modal has no SMS consent
checkbox. The only contact disclaimer is helper text under the phone
field: *"No email. No account. No password. Lauren, your case agent,
texts you back — usually in under 4 hours."* This implies texting but
**is not express written consent** under TCPA, and TCR reviewers
won't accept a screenshot of it as proof of opt-in.

**Add this checkbox above the "Send to Lauren" submit button**
(unchecked by default — pre-checked checkboxes are not valid consent):

```html
<label class="sms-consent">
  <input type="checkbox" name="sms_consent" required />
  <span>
    By checking this box, I agree to receive recurring text messages
    from RefundLocators (FundLocators LLC) at the mobile number I
    provided, including case updates, document requests, and follow-ups
    from my case agent. Message and data rates may apply. Message
    frequency varies. Reply HELP for help, STOP to cancel. Consent is
    not a condition of any service. See our
    <a href="https://fundlocators.com/privacypolicy" target="_blank">Privacy Policy</a>
    and
    <a href="https://fundlocators.com/terms-and-conditions" target="_blank">Terms</a>.
  </span>
</label>
```

**Notes for whoever ships this:**
- Must be `required` — the form should not submit without it checked.
- Must NOT be `checked` by default — TCR explicitly rejects pre-checked.
- Hyperlinks must open the correct policy URLs in a new tab.
- The phrase "Consent is not a condition of any service" is required
  by the FCC's 2024 update — leave it in.
- After you ship it, take a clean screenshot at desktop resolution
  showing the entire form WITH the checkbox visible and the labels
  legible. That's your TCR opt-in proof image.

---

## §2 — Privacy policy phone-number patch

**Audit finding:** `https://fundlocators.com/privacypolicy` lists
`+1 513-951-3014` as the HELP/STOP number. That's not Nathan's iPhone
(`+1 513-516-2306`), not the Twilio FundLocators Main number
(`+1 513-998-5440`), and we don't have any record of who owns it.
TCR rejects campaigns where the HELP/STOP number on the policy doesn't
match the registered sending number.

**Patch (replace the existing HELP/STOP line in the policy):**

> "Text HELP to **+1 (513) 998-5440** for support. Text STOP at any
> time to opt out of further messages."

**Why `+1 513-998-5440`:** that's the FundLocators Main Twilio number
already on the account, the one we'll register against the campaign.
If you decide to register a different/new number, change the policy
to that one before submitting to TCR.

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

> Opt-in occurs at refundlocators.com/s/<token>, a personalized claim
> page sent to identified property owners after our research team
> matches them to a public court record. The form has three required
> fields (mailing address, mobile number, signature) plus an
> unchecked SMS consent checkbox with the following label:
>
> "By checking this box, I agree to receive recurring text messages
> from RefundLocators (FundLocators LLC) at the mobile number I
> provided, including case updates, document requests, and follow-ups
> from my case agent. Message and data rates may apply. Message
> frequency varies. Reply HELP for help, STOP to cancel. Consent is
> not a condition of any service. See our Privacy Policy and Terms."
>
> The form will not submit unless the checkbox is checked. After
> submission, our case agent texts the user from the registered
> Twilio number within 4 hours.

### Opt-in screenshot

Upload a desktop screenshot of the `/s/{token}` claim form **after
§1's checkbox is shipped**, showing the entire form with the
checkbox visible and label legible. Recommended: zoom to ~125% before
screenshotting so the small print is readable in the upload.

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
> RefundLocators (FundLocators LLC): For support call (513) 998-5440 or
> email hello@fundlocators.com. Reply STOP to opt out. Msg&data rates
> may apply.

### Privacy policy URL
`https://fundlocators.com/privacypolicy`

### Terms URL
`https://fundlocators.com/terms-and-conditions`

### Embedded link / phone number
- Embedded link: `Yes` (we link `refundlocators.com/s/<token>` URLs)
- Embedded phone number: `Yes` (HELP replies include `(513) 998-5440`)

### Affiliate marketing
`No` (don't check this even though tempting — affiliate flag triggers
extra scrutiny and we don't actually have affiliates)

### Age-gated content
`No`

### Direct lending / loans
`No` (we recover money owed, we don't lend)

### Number pool
Assign `+1 513-998-5440` (and any future numbers).

---

## §6 — Common rejection reasons + how to respond

| Rejection reason | Likely cause | Fix |
|---|---|---|
| "Privacy policy missing required mobile information clause" | Carriers grep for "mobile information will not be shared" | Already present in fundlocators.com policy — verify the exact phrase wasn't accidentally edited |
| "Opt-in flow does not constitute express written consent" | Pre-checked checkbox, no checkbox at all, or vague language | §1 fixes this — must be unchecked-by-default and use the FCC's "consent is not a condition" language |
| "Sample messages do not match opt-in flow" | Sample says "Hi {firstname}" but opt-in flow doesn't capture first name | Either capture first name on the form OR change samples to use the property address as identifier |
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
| **Warm — opted in via /s/{token} checkbox** | Filled the form, checked the consent box | **Twilio A2P (the registered campaign)** |
| **Cold — auction-discovered, not yet responded** | Castle's sweep matched their name | **Mac bridge / iMessage from Nathan's phone** (current flow). Don't scale this 10x. |

If you commingle (send cold leads through the registered Twilio
campaign), you're at TCPA risk on every text. **Strongly recommend
running this past a TCPA-aware attorney before pushing send on
the registered campaign with anyone outside the warm cohort.**

This is operational guidance, not legal advice. I'm not your lawyer.

---

## §8 — Acceptance checklist

Before clicking "Submit Campaign", verify all of these:

- [ ] §1 — Consent checkbox shipped on `/s/{token}` claim modal, unchecked by default, required
- [ ] §1 — Screenshot taken of the form with checkbox visible
- [ ] §2 — Privacy policy HELP/STOP number updated to `+1 513-998-5440`
- [ ] §3 — Terms SMS clause added (optional but recommended)
- [ ] §4 — Brand registration submitted and approved
- [ ] EIN, authorized rep details, mobile number all in hand
- [ ] §7 — TCPA caveat understood; have a plan for cold-vs-warm channel split

Once submitted, monitor Twilio Console daily until the campaign moves
from "Submitted" → "In Review" → "Approved". Any rejection comes back
with a reason; iterate via §6.
