# On-Demand Court Pull — Castle Handoff

**From**: DCC Claude (Nathan's session)
**To**: Castle Claude
**Written**: 2026-04-22
**Status**: DCC side shipped. Castle side needs to be built.

---

## TL;DR

Nathan wants a "🔍 Pull from court" button on any DCC deal that has a case number + county. Clicking it should trigger Castle to scrape the county's court system for that case, fetch every PDF document, upload them into the DCC deal's storage, analyze each one via the existing `extract-document` Edge Function, and insert the corresponding docket events.

**DCC has shipped:**
- `public.court_pull_requests` table (queue)
- `<CourtPullButton>` component inside the Overview tab of both surplus + flip deals
- Button is disabled unless Case # and County are both filled
- Shows live status: queued / processing / done / failed with docs+events counts
- Realtime subscription — row updates appear instantly in the UI

**Castle needs to build:**
- A poller that reads `court_pull_requests where status='queued'`
- For each row, run the matching county scraper with `case_number` as input
- Upload fetched PDFs to DCC's `deal-docs` storage bucket
- Insert matching `documents` rows (will auto-trigger `extract-document`)
- Insert matching `docket_events` rows (pre-existing flow)
- Update the `court_pull_requests` row with final status + counts

---

## Queue schema

```sql
public.court_pull_requests (
  id uuid primary key default gen_random_uuid(),
  deal_id text not null references deals(id),
  case_number text not null,
  county text not null,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'done', 'failed', 'cancelled')),
  requested_by uuid references auth.users(id),
  requested_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  error text,
  documents_added integer default 0,
  events_added integer default 0,
  notes text
)
```

RLS: admin full access, VA insert+select. Service role bypass means Castle
(running under service key) can do anything it needs. No RLS concerns on
Castle's side.

Index on `(requested_at) where status='queued'` makes the poll query cheap
no matter how many completed requests accumulate.

---

## Recommended Castle poll loop

```python
# pseudo-code — integrate into existing Castle monitor_mode.py

POLL_INTERVAL_SECONDS = 30

def poll_for_court_pulls(supabase, config):
    # Atomically claim the oldest queued request
    row = supabase.rpc('claim_court_pull_request').execute()  # or inline SQL
    if not row:
        return  # nothing to do

    req_id = row['id']
    deal_id = row['deal_id']
    case = row['case_number']
    county = row['county']

    try:
        county_cfg = load_county_config(county)  # from config/counties_ohio.json
        if not county_cfg or county_cfg.get('status') != 'live':
            mark_failed(supabase, req_id, f'{county} scraper not built yet')
            return

        # Run the scraper
        events, pdf_paths = run_case_fetch(county_cfg, case)

        # Upload PDFs to deal-docs bucket
        docs_added = 0
        for pdf_path in pdf_paths:
            storage_path = f'{deal_id}/{timestamp}_{filename}'
            supabase.storage.from_('deal-docs').upload(storage_path, open(pdf_path, 'rb'))
            supabase.from_('documents').insert({
                'deal_id': deal_id,
                'name': filename,
                'path': storage_path,
                'size': os.path.getsize(pdf_path),
                'uploaded_by': None,  # Castle is service-account
                'extraction_status': 'pending',
                'extracted': {'source': 'castle_court_pull', 'request_id': req_id},
            }).execute()
            docs_added += 1

        # Insert docket events (same pattern as webhook)
        events_added = 0
        for ev in events:
            # use existing docket-webhook logic to insert, or call it via HTTP
            upsert_docket_event(supabase, deal_id, ev)
            events_added += 1

        mark_done(supabase, req_id, docs_added, events_added)

    except Exception as e:
        mark_failed(supabase, req_id, str(e)[:500])
```

**Concurrency control:** only one Castle worker should claim a given row. The
cleanest pattern is a `claim_court_pull_request` RPC on the DB side that does
atomic `UPDATE ... WHERE status='queued' ORDER BY requested_at LIMIT 1 RETURNING *`.
Or just `SELECT ... FOR UPDATE SKIP LOCKED` inside a transaction. Either works.

---

## Document upload details

`deal-docs` bucket exists and is RLS-restricted to team users + the document's
deal's client. Castle (service role) bypasses this.

`documents` row shape for PDFs Castle pulls:
- `deal_id` — the deal the request was made against
- `name` — human-readable filename (e.g. "Sheriff Apprasial.pdf")
- `path` — storage path inside the bucket (e.g. `sf-jennings-moa9iqzt/2026-04-22-sheriff-apprasial.pdf`)
- `size` — file size in bytes
- `uploaded_by` — `null` (Castle is service-account)
- `extraction_status` — `'pending'` so the UI shows "Extract" button. Or
  better: call the `extract-document` Edge Function directly via service key
  so analysis auto-starts and finishes before Castle marks the pull done
- `extracted` — optional jsonb. Castle can stash source metadata here:
  `{"source": "castle_court_pull", "request_id": "<uuid>", "court_url": "..."}`

**Tip**: after each document insert, call the `extract-document` Edge Function
with the new document's id. The function already handles CORS + auth for
service-role calls. This way Castle delivers analyzed docs, not raw PDFs.

---

## Docket events details

Castle already owns this path — it's the existing `docket-webhook` flow
using `docket_events` table. No new schema. The on-demand pull just inserts
events the same way the cron monitor does, tagged with `is_backfill=false`
since this is a live user-initiated pull, not a historical scan.

If the pull covers historical events Castle has never seen, those should still
be marked `is_backfill=false` — from Nathan's perspective, anything he pulls
on-demand is "present context," not noise to filter. The backfill flag is for
distinguishing "first-time deal onboarding imported 5 years of history" from
"new event just happened."

---

## Supported counties

Castle config already has:
- **Butler** (CourtView, live)
- **Franklin** (ProWare, live)

For other counties, Castle should mark the request `failed` with a clear
error: `"scraper not built for {county} yet — queued for future build"`.
DCC UI is already prepared to show this gracefully ("⚠ {County} scraper not
built yet — request will queue for build"), but it's on Castle to actually
set the status.

A smarter future version: track which counties have scrapers built in a
new `config_counties` table, and have DCC check that table before offering
the button. Not needed for MVP.

---

## Test case ready to go

**Casey Jennings** (deal `sf-jennings-moa9iqzt`) is set up for the first
real test:
- Butler County
- Case number `CV 2022 08 1416`
- Already has 2 Sheriff PDFs manually uploaded (that's what prompted Nathan to build this — he wanted Castle to do it automatically next time)
- Homeowner phone + property address + plaintiff + judgment amount all seeded from the docs already

When Nathan clicks "🔍 Pull from court" on Casey's deal, a row lands in
`court_pull_requests`. Castle needs to pick it up, run the Butler CourtView
scraper with case `CV 2022 08 1416`, pull every PDF on the docket, upload
them, classify them, and fill in the Documents tab.

---

## Out of scope for this handoff

- Lauren AI as the "brain" that drives all of this autonomously — that's
  Phase 6 and a separate design conversation.
- Cross-county fuzzy search (given just a name + address, find the case
  without knowing the number). That's a separate, harder problem — probably
  the Lauren flow handles it on the refundlocators.com front door.
- Automatic classification of "this is a flip opportunity" vs "this is a
  surplus opportunity" based on docket state. DCC already has that via the
  preforeclosure lead_type field.

---

## Domain boundary

This work sits squarely in Nathan's domain (Castle / docket integration)
per DCC CLAUDE.md Domain Ownership table. Don't touch Justin's lanes
(SMS/Twilio, iMessage bridge, Lauren pgvector). `court_pull_requests` is a
Nathan-domain table.
