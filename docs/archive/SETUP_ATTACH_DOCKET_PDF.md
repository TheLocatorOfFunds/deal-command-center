# Setup — Auto-attach docket PDFs

Five manual steps. Supabase MCP is still auth-expired, so these can't be done
from my session. ~5 minutes total.

## 1. Generate a shared secret

```bash
openssl rand -hex 32
```
Copy the output.

## 2. Set the Edge Function secret

Supabase Dashboard → Project Settings → Edge Functions → Secrets:
- Name: `ATTACH_DOCKET_PDF_SECRET`
- Value: (hex from step 1)

## 3. Deploy the Edge Function

```bash
cd ~/Documents/Claude/deal-command-center
supabase functions deploy attach-docket-pdf --no-verify-jwt --project-ref rcfaashkfpurkvtmsmeb
```

Or via Dashboard → Edge Functions → upload from `supabase/functions/attach-docket-pdf/index.ts`.

## 4. Store the secret in Vault (for the trigger to read)

Supabase Dashboard → Database → Vault → New Secret:
- Name: `attach_docket_pdf_secret`
- Secret: (same hex from step 1)

## 5. Apply the migration

Supabase SQL Editor: https://supabase.com/dashboard/project/rcfaashkfpurkvtmsmeb/sql/new

Paste the contents of `supabase/migrations/20260424210000_docket_auto_attach_pdf.sql` and run.

This creates the `trigger_attach_docket_pdf()` function + the
`tg_attach_docket_pdf` trigger on `docket_events`.

## Smoke test

Once setup is done, the next time Castle posts a docket event with a
`document_url`, the trigger fires. Within ~10 seconds you should see on that
deal's Docket tab:

- **📎 Open attached PDF** button next to the existing "View on court site →"
- The same PDF appears on the Files tab as a documents row named
  `docket-<event_type>-<date>.pdf`
- After 10-15 more seconds, the document's extracted-fields summary populates
  via the existing Claude Vision OCR path

Test manually without waiting for Castle:
```bash
curl -X POST https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/attach-docket-pdf \
  -H "X-Attach-Docket-PDF-Secret: <your hex>" \
  -H "Content-Type: application/json" \
  -d '{"docket_event_id": "<some event id with document_url>"}'
```

Expected response on success:
```json
{ "attached": true, "document_id": "...", "filename": "...", "size": 123456 }
```

Possible graceful-skip responses (fine, doesn't retry):
- `{ "skipped": true, "reason": "no url" }`
- `{ "skipped": true, "reason": "already attached" }`
- `{ "skipped": true, "reason": "backfill" }`
- `{ "skipped": true, "reason": "fetch_failed", "error": "..." }` — some courts
  block direct scraping; existing "View on court site →" link still works

## How it works

```
Castle POSTs event → docket-webhook inserts row → tg_attach_docket_pdf trigger
  → pg_net.http_post(attach-docket-pdf, { docket_event_id })
  → Edge Function fetches PDF from document_url
  → uploads to deal-docs/<deal_id>/docket/<event_id>.pdf
  → inserts documents row (extraction_status='pending')
  → updates docket_events.document_ocr_id → doc.id
  → fires extract-document for OCR
```

Non-blocking: if the fetch fails (court blocks scraping, Cloudflare challenge,
auth required), the webhook insert still succeeded and Nathan still has the
"View on court site →" link. The PDF just doesn't auto-attach.

## To retroactively attach a backfill PDF

The trigger intentionally skips backfill rows (857 existing events on Casey
Jennings alone). If you want one specific old PDF attached, call the function
manually:

```bash
curl -X POST https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/attach-docket-pdf \
  -H "X-Attach-Docket-PDF-Secret: <your hex>" \
  -H "Content-Type: application/json" \
  -d '{"docket_event_id": "<event id>"}'
```

The function checks `is_backfill` — wait, actually it skips backfill too. If
you want to force it on a backfill row, temporarily set `is_backfill=false` on
that one row, call the function, it works.

## Cost

- Small: each PDF fetch is a single HTTP call. Storage is pennies per GB.
- Claude Vision OCR: ~$0.05 per doc. For Casey (49 docs) that would be
  ~$2.50 if we backfilled.
