# Castle handoff — poller down + Hamilton scraper missing

**Date:** 2026-04-24
**From:** DCC Claude session
**To:** Castle Claude session (`~/Documents/Claude/refundlocators-pipeline`)
**Priority:** P1 — poller is stuck, Nathan's court-pull button is dead on the floor.

## What Nathan is seeing

On a Hamilton County deal in DCC, the "🔍 Pull from court" button was clicked **35+ minutes ago** and the status chip still reads **`Queued · 35m ago`** — no movement to `processing`, `done`, or `failed`.

## Two problems, in order of urgency

### Problem 1 — Castle's queue poller isn't consuming `court_pull_requests`

This is the blocker. If the poller were alive, the row would already be in one of the terminal states — at minimum `failed` with "scraper not built yet" since Hamilton has no scraper. Still `queued` after 35 min = **Castle isn't calling `claim_court_pull_request()`.**

### Problem 2 — No Hamilton scraper exists

Even after you fix the poller, a Hamilton pull will still fail. Nathan already documented the working pattern (see below); it just needs to be ported into Castle.

## Diagnosis — run this first

```sql
-- Supabase SQL Editor:
-- https://supabase.com/dashboard/project/rcfaashkfpurkvtmsmeb/sql/new

-- 1. When was Castle last alive?
select id, county, started_at, finished_at, events_found, events_inserted
from public.scrape_runs
order by started_at desc
limit 10;

-- If the newest started_at is > 10 min old, the daemon is definitely down.

-- 2. What's actually in the pull queue?
select id, deal_id, county, case_number, status, requested_at, started_at, error
from public.court_pull_requests
order by requested_at desc
limit 10;

-- 3. Does the claim RPC even work? (run as service_role from Castle, not here)
-- select * from public.claim_court_pull_request();
```

### On the Mac Mini

```bash
# Is the daemon running?
launchctl list | grep -i castle

# If nothing, or if the exit code is non-zero, it died.
# Plist is usually at:
ls -la ~/Library/LaunchAgents/ | grep -i castle

# Reload:
launchctl unload ~/Library/LaunchAgents/<castle-plist>
launchctl load   ~/Library/LaunchAgents/<castle-plist>

# Logs — stderr is where stack traces go:
tail -f /var/log/castle-*.log    # or wherever HANDOFF.md says logs live
```

## The contract (so you don't have to re-derive it)

Castle ↔ DCC queue lives in `public.court_pull_requests`. Schema (from `supabase/migrations/20260422180000_court_pull_requests.sql` in DCC repo):

| column | type | notes |
|---|---|---|
| id | uuid PK | — |
| deal_id | text FK → deals(id) | — |
| case_number | text | — |
| county | text | — |
| status | text | `'queued' \| 'processing' \| 'done' \| 'failed' \| 'cancelled'` |
| requested_at | timestamptz | when DCC created the row |
| started_at | timestamptz | when Castle claimed it |
| completed_at | timestamptz | when Castle finished |
| error | text | human-readable failure reason |
| documents_added | int | PDFs uploaded to deal-docs |
| events_added | int | docket_events inserted |

**Claim RPC:** `public.claim_court_pull_request()` — service_role only, atomic, returns a row (or all-nulls when empty). Uses `FOR UPDATE SKIP LOCKED` so multi-worker is safe.

**Happy path Castle should implement:**
```
loop forever:
  row = claim_court_pull_request()        # status → 'processing'
  if row.id is null: sleep 15s; continue

  try:
    if row.county not in SUPPORTED_COUNTIES:
      update row set status='failed', error='scraper not built yet for '||county, completed_at=now()
      continue

    events, pdfs = scrape(row.county, row.case_number)
    upload_pdfs_to_storage(row.deal_id, pdfs)
    insert_documents_rows(...)   # triggers extract-document OCR via existing DCC path
    insert_docket_events(...)    # triggers attach-docket-pdf for live events

    update row set status='done', completed_at=now(),
      documents_added=len(pdfs), events_added=len(events)

  except Exception as e:
    update row set status='failed', error=str(e)[:500], completed_at=now()
```

**Missing defensive behavior to add while you're in there:**
- If `claim_court_pull_request()` returns a row for an unsupported county, **mark it `failed` immediately** instead of trying to run a scraper that doesn't exist. Right now it sounds like the poller either crashes silently on unsupported counties, doesn't run at all, or never claims the row. Whichever it is, the row should never sit `queued` indefinitely once picked up.

## Hamilton scraper — the pattern is already documented

Nathan's memory file: `~/.claude/projects/-Users-alexanderthegreat-Documents-Claude/memory/project_hamilton_courtclerk_pattern.md`

Key facts (from that memory):
- **Site:** `courtclerk.org` (Hamilton County Clerk of Courts)
- **Fetching:** Bright Data Web Unlocker, **two-call pattern**
- **Case numbers are always A-prefix** (e.g. `A1234567`) — strip/validate accordingly
- **`sec=history` endpoint returns Error 0626 unless you send a `Referer` header** matching the case detail page. That's the bypass.

Implementation sketch:
```python
def scrape_hamilton(case_number: str) -> tuple[list[Event], list[Pdf]]:
    assert case_number.startswith('A'), f"Hamilton cases are A-prefix, got {case_number}"
    # Call 1: case detail page — establishes the referer
    detail_url = f"https://www.courtclerk.org/case/?casenumber={case_number}&sec=party"
    detail_html = web_unlocker_fetch(detail_url)
    # Call 2: docket history — MUST send Referer: detail_url or you get Error 0626
    history_url = f"https://www.courtclerk.org/case/?casenumber={case_number}&sec=history"
    history_html = web_unlocker_fetch(history_url, headers={'Referer': detail_url})
    events = parse_history(history_html)
    pdfs = [fetch_pdf(e.pdf_url) for e in events if e.pdf_url]
    return events, pdfs
```

Then register in Castle's county dispatcher (wherever Butler + Franklin are wired), and after it ships, **update DCC's allow-list** at `index.html:6129`:
```js
const COURT_PULL_SUPPORTED_COUNTIES = new Set(['Butler', 'Franklin', 'Hamilton']);
```

## After you fix it

1. Clear the stuck row so Nathan's button unblocks:
   ```sql
   update public.court_pull_requests
      set status = 'cancelled', completed_at = now(),
          error = 'Castle poller was down — cancelled by handoff cleanup'
    where status = 'queued';
   ```
2. Insert a test Butler row (manually, via SQL) and watch it flip queued → processing → done in under a minute to prove the poller is healthy.
3. Then tackle Hamilton.
4. Update `WORKING_ON.md` in the DCC repo (or post a note back) when done so the DCC Claude knows to add Hamilton to the allow-list.

## Files you'll want in front of you

In the Castle repo (`~/Documents/Claude/refundlocators-pipeline`):
- `HANDOFF.md` — Castle's main knowledge base
- Wherever the queue poller lives (search for `claim_court_pull_request`)
- Wherever Butler/Franklin scrapers are defined (copy the shape for Hamilton)

In the DCC repo (read-only for your purposes):
- `supabase/migrations/20260422180000_court_pull_requests.sql` — table schema
- `supabase/migrations/20260422200000_claim_court_pull_request_rpc.sql` — claim RPC definition
- `CASTLE_COURT_PULL_HANDOFF.md` — the original spec that set up this contract
- `index.html:6129` — the DCC-side allow-list to update after Hamilton ships
