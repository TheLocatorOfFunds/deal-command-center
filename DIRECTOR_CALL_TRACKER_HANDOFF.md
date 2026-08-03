# Director → DCC: finish the call tracker (2 small UI tasks + 1 hygiene)

From the **Main-Intel Director** session, 2026-06-29. Nathan asked me to set up a call tracker for
**Eric** (appointment-setting cold calls on our surplus leads). I built the data foundation; two
pieces are in your lane (the app). Self-contained — act on it cold.

## What's already done (don't redo)
- **`v_call_tracker` view is live** (read-only, on `call_logs`). Per-caller, per-day, outbound:
  `call_date · caller · dials · connected · voicemail · no_answer · bad_number · booked · not_interested · connect_pct`.
  Works NOW on existing data — Eric today: **12 dials / 5 voicemail / 1 connected / 3 bad-number**.
- Eric is already dialing through the dialpad and logging connection outcomes (`call_logs.user_id`,
  `call_logs.outcome`, etc. — 197 rows, Twilio-linked).
- The `booked` + `not_interested` columns read **0** only because those outcomes don't exist in the
  UI yet → **Task 1**.

⚠ I created the view ad-hoc via SQL (not in a migration). **Task 3** captures it so it's tracked.

## Task 1 — add the two outcomes that actually matter (booked + not-interested)
Eric's a setter; the KPI is **appointments booked**. Today the outcome options are only connection
states (`connected`, `voicemail`, `no_answer`, `disconnected`, `wrong_number`). Add to the call-outcome
picker (the dialpad outcome control / wherever `call_logs.outcome` gets set):
- **`booked`** — "Booked appointment" (the win)
- **`not_interested`** — "Not interested"
- **`do_not_call`** — "Do Not Call" (hard opt-out)

`call_logs.outcome` is free text, so this is just adding the options + labels — **no schema change**.

**Bonus (closes the compliance loop):** when Eric marks **`do_not_call`**, also flip the linked contact's
DND flag so we never re-dial them —
`UPDATE contacts SET do_not_call=true, dnd_set_at=now(), dnd_reason='phone opt-out' WHERE id = <call_logs.contact_id>`.
That matches the opt-out rule in the call script Eric's working from.

**Acceptance:** Eric can tag a call Booked / Not-interested / Do-Not-Call; the value lands in
`call_logs.outcome`; `v_call_tracker.booked` + `.not_interested` start counting; a `do_not_call` tag sets
`contacts.do_not_call`.

## Task 2 — surface the scoreboard in the Calls view (📞 Calls / CallHistoryView)
Add an **admin-only** panel at the top of the Calls view that reads `v_call_tracker` — a small table,
most-recent-days first, one row per caller per day, columns as listed above. So Nathan can glance at
Eric's (and later Inaam's) numbers without SQL. Read-only; gate to admins (it's a management view).

## Task 3 — capture the view in a migration (hygiene)
Add a migration with the DDL (it already exists in prod from my ad-hoc `CREATE`; this just makes it
version-controlled + reproducible — `CREATE OR REPLACE` is idempotent):
```sql
CREATE OR REPLACE VIEW v_call_tracker AS
SELECT date(cl.created_at AT TIME ZONE 'America/New_York') AS call_date,
       cl.user_id, p.name AS caller,
       count(*) AS dials,
       count(*) FILTER (WHERE cl.outcome='connected') AS connected,
       count(*) FILTER (WHERE cl.outcome='voicemail') AS voicemail,
       count(*) FILTER (WHERE cl.outcome='no_answer') AS no_answer,
       count(*) FILTER (WHERE cl.outcome IN ('disconnected','wrong_number')) AS bad_number,
       count(*) FILTER (WHERE cl.outcome='booked') AS booked,
       count(*) FILTER (WHERE cl.outcome IN ('not_interested','do_not_call')) AS not_interested,
       round(100.0*count(*) FILTER (WHERE cl.outcome='connected')/NULLIF(count(*),0),0) AS connect_pct
FROM call_logs cl LEFT JOIN profiles p ON p.id=cl.user_id
WHERE cl.direction='outbound'
GROUP BY 1,2,3;
```

## Coordination
- **I won't touch `app.jsx` / your UI** — that's your lane (avoids the rebase collisions). The view +
  this spec are the Director side; Tasks 1–3 are yours.
- RLS: `v_call_tracker` inherits `call_logs` access — gate the UI panel to admins.
- No change to the DCC↔intel-main contract (`DIRECTOR_DCC_INTERFACE.md`).

Net: Tasks 1+2 are small and give Nathan the **booked-rate** visibility (the real KPI); Task 3 is hygiene.
Ping the Director queue if anything's unclear.
