# DocuSign Setup — PR 3 of Phase 3 Library

One-time admin configuration needed before the DCC "📝 Send for signature" button can actually send envelopes. All stays inside Nathan's existing DocuSign account — no third-party services.

**Your DocuSign account** (from Apr 22, 2026 API check):
- Account Name: `Nathan Johnson`
- Account ID: `001b848d-cd84-4b78-ada2-cff112350a2c`
- User ID: `6608a108-002e-4e7b-a185-849301ec24d2`
- Region: `https://na4.docusign.net` (NA4 production)
- Email on file: `nathan@defenderha.com`

**You'll need admin access** to https://admin.docusign.com for steps 1-3.

---

## Step 1 — Create an Integration Key (2 min)

1. Log into **DocuSign admin** → https://admin.docusign.com
2. Left sidebar: **Integrations → Apps and Keys**
3. Click **Add App and Integration Key**
4. Name it: `RefundLocators DCC`
5. Click **Create App**
6. On the next screen, note down the **Integration Key** (a UUID) — copy it, you'll paste it into Supabase in Step 4

---

## Step 2 — Generate an RSA keypair for JWT Grant (1 min)

Still on the same App config screen:

1. Scroll to **Authentication** section
2. Select **JWT Grant** auth type
3. Click **Generate RSA** (under "RSA Keypairs")
4. DocuSign generates a keypair. **The private key is shown ONLY ONCE** — copy the entire block including the `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----` lines.
5. Paste it into a 1Password note titled "DocuSign RSA private key" so it doesn't get lost.

**Important**: the private key must be in PKCS8 format (starts with `-----BEGIN PRIVATE KEY-----`). DocuSign's "Generate RSA" gives this format by default. If you already have an older PKCS1 key (`-----BEGIN RSA PRIVATE KEY-----`), convert it:
```bash
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in rsa-pkcs1.pem -out private-pkcs8.pem
```

---

## Step 3 — Grant admin consent for the impersonation scope (1 min)

DocuSign requires a one-time admin consent before the JWT Grant flow can impersonate a user. Without this, every send attempt returns `consent_required`.

**Construct this URL** (substitute your Integration Key from Step 1):

```
https://account.docusign.com/oauth/auth?response_type=code
  &scope=signature%20impersonation
  &client_id={INTEGRATION_KEY}
  &redirect_uri=https://www.docusign.com
```

(all on one line, with `{INTEGRATION_KEY}` replaced)

1. Paste the full URL into your browser
2. Log in as Nathan (`nathan@defenderha.com`)
3. A consent screen appears: "RefundLocators DCC wants to impersonate your account"
4. Click **Accept**
5. You'll be redirected to docusign.com — that's fine, consent is granted

---

## Step 4 — Add the 6 secrets to Supabase (3 min)

1. Go to https://supabase.com/dashboard/project/rcfaashkfpurkvtmsmeb/settings/functions
2. Scroll to **Edge Function Secrets**
3. Add these six secrets (copy-paste each, no quotes):

| Name | Value | Notes |
|---|---|---|
| `DOCUSIGN_INTEGRATION_KEY` | from Step 1 | the App's UUID |
| `DOCUSIGN_USER_ID` | `6608a108-002e-4e7b-a185-849301ec24d2` | your DocuSign user GUID (already captured) |
| `DOCUSIGN_ACCOUNT_ID` | `001b848d-cd84-4b78-ada2-cff112350a2c` | your account GUID |
| `DOCUSIGN_PRIVATE_KEY` | paste the entire PEM from Step 2 | including `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----` lines |
| `DOCUSIGN_BASE_URI` | `https://na4.docusign.net` | NA4 production |
| `DOCUSIGN_OAUTH_HOST` | `account.docusign.com` | production OAuth (NOT `account-d.docusign.com` — that's demo) |

---

## Step 5 — Disable JWT verification on the webhook Edge Function (30 sec)

DocuSign's Connect service posts to our webhook **without a Supabase JWT** (there's no Supabase user on that side). The Edge Function defaulted to JWT-required on deploy.

1. Go to https://supabase.com/dashboard/project/rcfaashkfpurkvtmsmeb/functions
2. Click the **docusign-webhook** function
3. **Settings** tab → find **"Verify JWT"** toggle
4. Turn it **OFF**
5. Save

(The `docusign-send-envelope` function keeps JWT verification **ON** — it's called from DCC by a signed-in user, so verification is correct.)

---

## Step 6 — Configure DocuSign Connect to call our webhook (3 min)

1. DocuSign admin → **Settings → Connect**
2. Click **Add Configuration → Custom**
3. Fill in:
   - **Name**: `DCC Webhook`
   - **URL to publish to**: `https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/docusign-webhook`
   - **Sign Message with X509 Certificate**: leave off (we use our own HMAC path instead — see optional Step 7)
   - **Trigger events**:
     - ☑ Envelope Sent
     - ☑ Envelope Delivered
     - ☑ Envelope Signed/Completed
     - ☑ Envelope Declined
     - ☑ Envelope Voided
4. Data format: **JSON**
5. Include these fields:
   - ☑ Envelope ID
   - ☑ Envelope Status
   - ☑ Recipient Info
   - ☑ Event Details
6. Save

---

## Step 7 (optional) — Lock webhook with HMAC (recommended for production)

By default our webhook accepts any POST with a known envelope ID. To harden:

1. DocuSign admin → **Settings → Connect → Keys**
2. Generate a new HMAC key, copy the secret
3. Add to Supabase Edge Function secrets: `DOCUSIGN_WEBHOOK_HMAC_KEY` = the secret you just copied
4. Back in DocuSign Connect, enable **Include HMAC Signature** on the DCC Webhook config
5. Our Edge Function auto-validates `X-DocuSign-Signature-1` header when the env var is present

---

## Step 8 — Wire your first template in DocuSign + DCC (5-10 min)

**In DocuSign admin:**

1. **Templates → New** (or edit an existing template)
2. Upload the source PDF (blank engagement letter, W-9, fee disclosure, etc.)
3. Add recipient role (e.g., "Signer 1")
4. Drag signature field onto the PDF where the client signs
5. Drag **Text** fields onto each merge-field spot on the PDF:
   - For each, set **Data Label** to the placeholder name you'll use in DCC (e.g., `ClientName`, `PropertyAddress`, `CaseNumber`, `ContingencyPct`, `AttorneyName`, `FiledDate`)
   - **Must match exactly** between DCC and DocuSign (case-sensitive)
6. Save the template
7. Copy the **Template ID** (visible in the URL when you're viewing the template: `/templates/{TEMPLATE_ID}`)

**In DCC library:**

1. Upload the same PDF to DCC Library (📚 → 02 — Templates folder → Upload)
2. Tell me: *"Mark it as a template with DocuSign template ID {ID}, fields ClientName, PropertyAddress, CaseNumber, ContingencyPct, AttorneyName, FiledDate"*
3. I run one SQL update:
   ```sql
   update public.library_documents
   set kind = 'template',
       docusign_template_id = '<DocuSign template UUID>',
       template_fields = '{
         "ClientName":      "deal.name",
         "PropertyAddress": "deal.address",
         "CaseNumber":      "deal.meta.courtCase",
         "ContingencyPct":  "deal.meta.feePct",
         "AttorneyName":    "deal.meta.attorney",
         "FiledDate":       "deal.filed_at"
       }'::jsonb
   where id = '<library doc UUID>';
   ```

4. Open any deal → Documents tab → **📝 Send for signature** → the template appears in the picker

---

## Step 9 — Verify end-to-end with a test send (3 min)

1. In DCC, open any surplus deal (Kemper's is a good one)
2. Click **📝 Send for signature**
3. Pick your template from the left
4. Review the merge values — all pre-filled from the deal
5. Confirm recipient email (point to YOUR email for the first test, not a real client's)
6. Optional: toggle SMS, enter your phone
7. Click **Send for signature**
8. The envelope-status card appears on the deal, showing "Waiting for signature"
9. Check your email — DocuSign invite arrives
10. Click, review the pre-filled template, sign
11. Back in DCC: status card flips to "Completed · filed to docs" within ~10 seconds
12. Scroll down the Documents tab: the signed PDF appears with `from_library_id` linking back to the template
13. Client portal (admin preview) shows activity entry: "✅ Signed: {template title} by {your name}"

---

## Troubleshooting

**"consent_required" error**: Step 3 wasn't completed — open the consent URL and Accept.

**"invalid_grant" error**: Private key format issue. Verify it starts with `-----BEGIN PRIVATE KEY-----` (not `-----BEGIN RSA PRIVATE KEY-----`). If PKCS1, convert per Step 2.

**Webhook not firing**: Check Step 5 (JWT verification off) and Step 6 (Connect config URL correct). DocuSign admin → Connect → Logs shows recent delivery attempts.

**Merge fields blank on signed doc**: Data Label on the DocuSign template Text field must match exactly (case-sensitive) with the key in `template_fields`.

**Status stuck on "Waiting for signature" even after signing**: Webhook isn't reachable. Verify the URL in Connect config is exactly `https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/docusign-webhook` and JWT verification is off on that function.

---

## What got built

| Piece | Location |
|---|---|
| `docusign_envelopes` table | Supabase Postgres |
| `docusign-send-envelope` Edge Function | Supabase Edge Functions |
| `docusign-webhook` Edge Function | Supabase Edge Functions |
| "📝 Send for signature" button | DCC DealDetail Documents tab |
| `DocuSignSendModal` component | `index.html` |
| Envelope-status tracker card | DCC DealDetail Documents tab |
| Realtime status updates | Subscribed to `docusign_envelopes` |

**What happens when signed**: webhook fires → downloads signed PDF → uploads to `deal-docs` bucket → creates `documents` row with `from_library_id` → logs client-visible "✅ Signed" activity → UI updates live.
