# Mac Mini bridge: phone-intel probe

**Owner:** Justin (mac_bridge daemon)
**DCC side already shipped:** migration `20260430200000_phone_intel.sql` + UI in Comms tab (per-phone dot + "Probe" button + status row above composer)

## What Nathan wants

Before sending a text, route based on whether the destination is iMessage-capable:

- **Blue (iMessage)** → send via iPhone bridge (`(513) 516-2306`)
- **Green (SMS)** → send via Twilio (`(513) 951-8855`)
- **Landline / VoIP / unreachable** → refuse to send

He wants this label persisted per-number so we don't re-probe on every send.

## Data contract — `public.phone_intel`

```
phone_e164         text PRIMARY KEY    -- '+1XXXXXXXXXX'
imessage_capable   boolean             -- true=blue, false=green, null=unknown
line_type          text                -- 'mobile','landline','voip','unreachable','unknown'
carrier            text                -- optional, future
probed_at          timestamptz
probe_method       text                -- 'mac_bridge'
probe_error        text                -- when probe failed
status             text                -- 'queued','probing','done','failed'
requested_at       timestamptz
requested_by       uuid                -- auth user who clicked Probe
do_not_text        boolean             -- override; honor in send paths
notes              text
```

## What the bridge needs to do

**1. Poll every ~30 seconds** for queued probes:

```sql
select phone_e164, requested_at
from phone_intel
where status = 'queued'
order by requested_at asc
limit 5;
```

**2. For each row:**

a. Mark `status = 'probing'` (so a second poll doesn't double-probe):
```sql
update phone_intel set status = 'probing', updated_at = now()
where phone_e164 = $1 and status = 'queued';
```

b. Run the AppleScript probe:
```applescript
-- Open Messages.app, address the number, wait for Apple's blue/green decision
tell application "Messages"
  set targetService to first service whose service type = iMessage
  -- Try to open a chat targeting the number
  -- Apple resolves "is this an iMessage account?" in ~1-3 seconds
  -- Read the result from the chat header / bubble color
end tell
```

The actual AppleScript is more involved than the snippet above — you'll need to:
- Type the number into a new chat
- Wait for Apple's API response (~3 sec)
- Read whether the destination shows blue (iMessage) or green (SMS), OR whether Messages refuses (landline/unreachable)
- Capture as `result = 'imessage' | 'sms' | 'unreachable' | 'error'`

c. Write the result back:
```sql
update phone_intel set
  status = 'done',
  imessage_capable = $imessage_capable,    -- true / false / null
  line_type = $line_type,                   -- 'mobile' / 'landline' / 'unreachable' / etc.
  probed_at = now(),
  probe_method = 'mac_bridge',
  probe_error = null
where phone_e164 = $phone;
```

If the AppleScript bombs:
```sql
update phone_intel set
  status = 'failed',
  probe_error = $error_message,
  probed_at = now()
where phone_e164 = $phone;
```

**3. Don't leave probes stuck in 'probing'.** If the bridge crashes mid-run, sweep:
```sql
update phone_intel set status = 'queued'
where status = 'probing' and updated_at < now() - interval '5 minutes';
```

## Routing change in `send-sms` EF (your call)

Once probes are populating, update outbound routing:

```ts
const intel = await sb.from('phone_intel')
  .select('imessage_capable, line_type, do_not_text')
  .eq('phone_e164', e164).maybeSingle();

if (intel?.do_not_text) return { skipped: 'do_not_text override' };
if (['landline','voip','unreachable'].includes(intel?.line_type)) {
  return { skipped: 'unreachable line type' };
}

const useBridge = intel?.imessage_capable === true;
// useBridge → existing iPhone gateway (mac_bridge)
// else → Twilio
```

For now (2306 down per memory), even iMessage-capable should fall back to Twilio with a notice. Flip the bridge path back on once 2306 is restored.

## Auto-probe on contact insert (optional, recommended)

A trigger on `contacts` INSERT/UPDATE that calls `queue_phone_probe()` for any new/changed phone would mean Eric never has to manually click — every imported phone gets queued automatically. Trivial Postgres trigger:

```sql
create or replace function public.tg_queue_phone_probe_on_contact()
returns trigger language plpgsql security definer as $$
begin
  if NEW.phone is not null and (TG_OP = 'INSERT' or NEW.phone is distinct from OLD.phone) then
    perform public.queue_phone_probe(<normalize NEW.phone to E164>);
  end if;
  return NEW;
end; $$;
```

Skip this if you'd rather control when probes fire.

## Test path

1. Eric clicks **Probe** on a phone in the Comms tab → DCC inserts a row with `status='queued'`
2. Bridge picks it up within ~30 sec → marks `status='probing'`
3. AppleScript runs → bridge writes back `status='done'` with `imessage_capable` set
4. DCC's realtime sub on `phone_intel` fires → the dot on the phone tab + status row above composer update without refresh
5. Next outbound send for that number routes via the appropriate gateway

## Edge cases worth handling

- **Same number probed twice**: UPSERT semantics on `queue_phone_probe()` already handle this — re-probing flips `status` back to `'queued'`. Safe to call repeatedly.
- **Number changes carrier (mobile → landline) after we cached it**: probe results don't expire automatically. Could add a "stale after 90 days" sweep, or rely on Eric re-probing manually when sends start failing.
- **Group iMessage**: out of scope for v1. We probe individual numbers only; group threads route via the existing `thread_key` logic.
- **iMessage capability is account-level, not number-level**: if someone has an Apple ID using their phone number, blue. If they have an Apple ID using only an email, the phone-number probe stays green even though they have iMessage on a different identifier. That's fine — we route on phone-number behavior.

— DCC side
