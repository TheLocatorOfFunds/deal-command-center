# Setup — DocuSign engagement agreement template

Goal: turn the existing `📤 DocuSign` button on every deal into a one-click engagement-agreement send. The button is wired; just needs a template to point at.

## What you do (Nathan, ~10 min in DocuSign + 1 piece of info back to me)

### Step 1 — Locate or create your engagement agreement template in DocuSign

1. Open https://app.docusign.com/templates
2. If you already have a template named something like "RefundLocators Engagement Agreement," skip to step 2
3. Otherwise: click **New** → **Create Template** → upload your engagement agreement Word doc
4. **Add merge field tabs** to the template — drag from the right sidebar onto the document at the spots where homeowner-specific data should appear. For each tab, set the **Data Label** to a clear name (these labels are what we'll map deal data to). Suggested labels:
   - `homeowner_name` (signature block, agreement opening)
   - `homeowner_address` (mailing address line)
   - `property_address` (the foreclosed property)
   - `county` (Hamilton, Franklin, etc.)
   - `case_number` (the court case ID)
   - `estimated_surplus` (the dollar figure)
   - `fee_percent` (your contingency %)
   - `agreement_date` (today's date — DocuSign auto-fills this if you use a Date Signed tab)
5. Add **two Recipient Roles**:
   - Role 1: `Client` (the homeowner)
   - Role 2: `Nathan` (you co-sign at the end, optional but standard)
6. **Save** the template

### Step 2 — Get the Template UUID

1. Open the template you just saved
2. Look at the URL — it ends in `/templates/.../<UUID>` OR right-click the template in the list and copy its ID
3. The UUID looks like `e8b4f2c1-0d9a-4b8e-9f3d-0c7e8d6a5f2b`
4. **Send me that UUID** plus the list of Data Labels you used

### Step 3 — I wire the rest (1 min once you give me the UUID)

I'll insert a `library_documents` row with:
```sql
insert into public.library_documents (
  title, kind, docusign_template_id, template_fields, visibility
) values (
  'Engagement Agreement',
  'template',
  '<your-uuid>',
  '{
    "homeowner_name":     "meta.homeownerName",
    "homeowner_address":  "meta.mailingAddress",
    "property_address":   "address",
    "county":             "meta.county",
    "case_number":        "meta.courtCase",
    "estimated_surplus":  "meta.estimatedSurplus",
    "fee_percent":        "meta.feePct"
  }'::jsonb,
  'admin_only'
);
```

The `template_fields` jsonb maps **each DocuSign Data Label** → the **path inside a deal row** that fills it.

If you used different Data Labels in step 1, send me the list and I'll adjust the mapping.

## Once it's wired

On every deal, the `📤 DocuSign` button (already in the deal detail Files tab) does this:

1. Pulls the deal's data
2. Resolves the merge fields from `template_fields`
3. POSTs to the `docusign-send-envelope` Edge Function
4. DocuSign creates the envelope from your template + the merged values
5. Email goes to the homeowner with the signing link
6. (Optional toggle on the modal) SMS reminder goes to their phone too
7. They sign
8. `docusign-webhook` fires when complete → signed PDF lands in the deal's `documents` table → Castle's case file is updated → activity row logged
9. Done. Zero typing.

## What this replaces

Today's manual flow (best case):
1. Open Word doc
2. Fill in homeowner name, address, surplus amount, fee %
3. Save as a new file
4. Upload to DocuSign manually
5. Type the recipient email + name
6. Add tabs again or copy from a template
7. Send

That's ~5 min per deal × 50 deals/month = 4 hours/month of pure typing. The button reduces it to <30 seconds per deal.

## DocuSign secrets that need to be set on the Edge Function

If the button currently returns "DocuSign not configured yet," you need these as Edge Function Secrets in Supabase:

- `DOCUSIGN_INTEGRATION_KEY` (from DocuSign Apps & Keys)
- `DOCUSIGN_USER_ID` (your DocuSign user UUID)
- `DOCUSIGN_ACCOUNT_ID` (your DocuSign account ID — visible at top of API/Apps page)
- `DOCUSIGN_PRIVATE_KEY` (the RSA private key from the JWT App config — paste the full PEM including BEGIN/END lines)
- `DOCUSIGN_BASE_URL` — for production: `https://www.docusign.net/restapi`. For sandbox: `https://demo.docusign.net/restapi`.

The Edge Function uses JWT Grant authentication, so no end-user OAuth flow needed. **First call requires a one-time JWT consent grant** — DocuSign will respond once with `consent_required` and a URL; open the URL, click Consent, then re-fire the send. After that it just works forever.

## Required from you to complete this

1. **DocuSign Template UUID** for the engagement agreement
2. **The list of Data Labels** you used in step 1 (so I can map them right)
3. (If not already set) **DocuSign Edge Function secrets** — paste the 5 values into Supabase Dashboard → Settings → Edge Functions → Secrets

Once I have items 1 + 2, the wire-up SQL runs in 30 seconds and you can test from any deal that has homeownerName + estimatedSurplus + feePct populated.

## Future: email send via DCC

Per your note: after we get DocuSign-via-text working, you also want email send via DCC. That's a separate ~30 min build:

- DCC `📧 Email` button next to the DocuSign one
- Pulls library `kind='template'` docs that have a separate `email_template` field (different from DocuSign templates — these are mail-merge style)
- Uses Resend (already configured in the project)
- Fires a `send-email` Edge Function (already built — it sends portal invites + claim notifications today)
- Adds a `library_documents.email_template` text column for the body, plus a UI to edit + preview

Will spec separately when you're ready.
