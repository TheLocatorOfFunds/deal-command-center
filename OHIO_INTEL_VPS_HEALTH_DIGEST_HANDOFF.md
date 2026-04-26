# Handoff: include ohio-intel VPS health in DCC's morning digest

**From:** Castle Claude (working from `~/Documents/Claude/ohio-intel/`) · 2026-04-26
**To:** DCC Claude (or Justin)
**Estimated effort:** ~15 min — one SQL migration appending to `send_daily_digest()`

---

## Context

Nathan now has a Hetzner VPS (`intel-vps` @ `5.161.200.249`) running ohio-intel's 5 Castle scrapers under systemd. He wants a small "VPS health" blurb in his existing morning digest email at 8am EDT.

The ohio-intel side is **done and live**:

1. New table `intel.vps_health` (via migration `0005_vps_health.sql`) — needs Nathan to paste into Supabase SQL editor for project `wjdmdggircdengdingtn`. (Source: `~/Documents/Claude/ohio-intel/db/migrations/0005_vps_health.sql`)
2. VPS systemd timer `vps-health.timer` runs daily at 07:45 ET → POSTs a row to `intel.vps_health` via REST. (Active on box now.)
3. Convenience view `intel.v_vps_health_latest` returns just the most recent row.

After migration 0005 lands, every morning at 07:45 ET ohio-intel writes one health row, ready for DCC's 08:00 ET digest to read.

---

## What DCC needs to do

Append a new section to `public.send_daily_digest()` that:

1. Calls `pg_net.http_get()` on ohio-intel's REST endpoint for `v_vps_health_latest`
2. Renders a small HTML block in the email body
3. Gracefully handles "no row yet" / "fetch failed" (just omit the section, don't error)

### Endpoint

```
GET https://wjdmdggircdengdingtn.supabase.co/rest/v1/v_vps_health_latest?select=*
Headers:
  apikey: <ohio-intel anon key — see below>
  Authorization: Bearer <same anon key>
```

### Credentials decision needed

The cleanest approach uses the **ohio-intel anon key**, NOT the service-role key.

- **Why anon, not service-role**: service-role bypasses RLS and is too privileged to embed in a digest function. Anon is publicly safe.
- **What we need to do first**: the `vps_health` table has no RLS policies yet. Add a policy allowing anon to SELECT from `v_vps_health_latest` (or just from `vps_health`). That's a one-line addition to migration `0005`. Or as a follow-up migration `0006`.
- **Ohio-intel anon key**: available in `wjdmdggircdengdingtn` Supabase dashboard → Project Settings → API → anon public. Justin/Nathan need to copy it once and store in DCC's Vault (suggested name: `ohio_intel_anon_key`).

### Suggested SQL append (drop into a new DCC migration)

```sql
-- DCC migration: add VPS health section to morning digest

-- 1. Pull anon key into a server-side var (Vault)
-- Justin: store the ohio-intel anon key in Vault first:
--   select vault.create_secret('eyJ...', 'ohio_intel_anon_key', 'ohio-intel anon for vps health pull');

-- 2. Helper to fetch + cache the latest VPS health row
create or replace function public.fetch_ohio_intel_vps_health()
returns jsonb
language plpgsql
security definer
as $$
declare
  v_anon text;
  v_request_id bigint;
  v_response record;
  v_row jsonb;
begin
  select decrypted_secret into v_anon
  from vault.decrypted_secrets
  where name = 'ohio_intel_anon_key';

  if v_anon is null then
    return null;  -- vault not set up yet; digest just omits section
  end if;

  -- async http get (pg_net pattern)
  select net.http_get(
    url := 'https://wjdmdggircdengdingtn.supabase.co/rest/v1/v_vps_health_latest?select=*',
    headers := jsonb_build_object(
      'apikey', v_anon,
      'Authorization', 'Bearer ' || v_anon,
      'Accept', 'application/json'
    ),
    timeout_milliseconds := 5000
  ) into v_request_id;

  -- Wait briefly for response (up to 5s)
  perform pg_sleep(2);

  select * into v_response
  from net._http_response
  where id = v_request_id;

  if v_response is null or v_response.status_code != 200 then
    return null;
  end if;

  v_row := (v_response.content::jsonb -> 0);
  return v_row;
exception when others then
  return null;  -- fail-soft; never break the digest
end;
$$;

-- 3. In send_daily_digest, after the existing sections, append:
/*
  v_vps_health := public.fetch_ohio_intel_vps_health();
  if v_vps_health is not null then
    v_html := v_html || format(
      '<div style="margin-top:24px; padding:12px; border-left:3px solid %s; background:%s;">' ||
      '<h3 style="margin:0 0 6px 0; color:%s;">VPS health · intel-vps</h3>' ||
      '<p style="margin:0; font-size:13px; color:#444;">' ||
      'mem %s/%s MB · swap %s MB · disk %s%% · load5 %s · OOM(7d) %s' ||
      '%s' ||
      '</p></div>',
      case v_vps_health->>'severity' when 'red' then '#c0392b' when 'yellow' then '#e67e22' else '#27ae60' end,
      case v_vps_health->>'severity' when 'red' then '#fdf3f2' when 'yellow' then '#fef5e7' else '#eafaf1' end,
      case v_vps_health->>'severity' when 'red' then '#c0392b' when 'yellow' then '#e67e22' else '#27ae60' end,
      v_vps_health->>'mem_used_mb',
      v_vps_health->>'mem_total_mb',
      coalesce(v_vps_health->>'swap_used_mb', '0'),
      v_vps_health->>'disk_used_pct',
      coalesce(v_vps_health->>'load_avg_5m', '?'),
      coalesce(v_vps_health->>'oom_kills_7d', '0'),
      case when v_vps_health->>'notes' is not null
        then '<br><span style="color:#666; font-style:italic;">' || (v_vps_health->>'notes') || '</span>'
        else ''
      end
    );
  end if;
*/
```

(The `v_html` variable name is a guess — replace with whatever `send_daily_digest` actually uses for its accumulator. The function body is at `supabase/migrations/<old-timestamp>_send_daily_digest.sql` — read first, then patch.)

### Output Nathan will see

If everything's green, a small green-bordered card under his existing digest sections:

```
VPS health · intel-vps
mem 423/1972 MB · swap 0 MB · disk 15% · load5 0.32 · OOM(7d) 0
```

If yellow/red, the card border + heading turn orange/red and Nathan sees the `notes` field below — e.g. "swap_used=612MB > 500MB" or "OOM kills in last 7d: 1 — upgrade to CPX21 minimum".

---

## RLS policy needed on ohio-intel side

Before this works, ohio-intel needs to allow anon to read `vps_health`. I'll add that as migration `0006_vps_health_anon_read.sql` in the ohio-intel repo and ask Nathan to apply it. **You don't need to do anything DCC-side until that's in place** — until then, `fetch_ohio_intel_vps_health()` will return null and the digest will gracefully skip the section.

---

## Sequence

1. **Nathan** applies `0005_vps_health.sql` to ohio-intel's Supabase (manual paste in SQL editor) — one-time
2. **Nathan** applies `0006_vps_health_anon_read.sql` (RLS policy) — one-time
3. **Nathan/Justin** copies ohio-intel anon key into DCC's Supabase Vault as `ohio_intel_anon_key` — one-time
4. **DCC Claude** writes the digest patch as a new DCC migration, applies, redeploys (no Edge Function change — `send_daily_digest()` is pure pg)
5. Tomorrow morning: Nathan's 8am email has the new VPS health section

Steps 1-3 are 5 minutes total, no coding. Step 4 is the actual DCC work.

---

## Test path before sending the next real digest

After steps 1-4 are done, manually invoke the digest from the Supabase SQL editor:

```sql
select public.send_daily_digest();
```

Verify the email arrives with the new section. (DCC Claude already knows this pattern — it's how every digest tweak gets QA'd.)

— Castle Claude, 2026-04-26
