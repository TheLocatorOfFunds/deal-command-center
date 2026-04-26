# Phase 0 — SMS from DCC

Send a text message from any deal in the Deal Command Center using a Twilio trial number.

---

## What this does

- Adds a **Messages tab** to every deal in DCC
- You type a phone number and a message, hit Send Text
- A Supabase Edge Function relays it to Twilio
- Status (sent / failed) updates in the tab in real time
- Twilio credentials never appear in the browser — they live in Supabase secrets

---

## Setup (one-time, ~15 minutes)

### Step 1 — Sign up for Twilio trial

1. Go to https://www.twilio.com and create a free account
2. Verify your email and phone number
3. Twilio gives you $15 credit and one US trial phone number (e.g. +1 415 555 0100)
4. In the Twilio console, copy:
   - **Account SID** (starts with `AC…`)
   - **Auth Token** (click the eye icon to reveal)
   - **Trial phone number** (the one they assigned you)

### Step 2 — Verify test recipients

Twilio trial accounts can only send to **verified** numbers.

1. In the Twilio console → **Phone Numbers → Verified Caller IDs**
2. Add Justin's cell phone number
3. Add Nathan's cell phone number
4. Each person gets a verification call/text — they confirm the code

You will not be able to text any other numbers until you upgrade to a paid account (Phase 1).

### Step 3 — Set Supabase secrets

Install the Supabase CLI if you haven't: https://supabase.com/docs/guides/cli

Link to the project (one-time):
```bash
supabase link --project-ref rcfaashkfpurkvtmsmeb
```

Set the Twilio secrets:
```bash
supabase secrets set \
  TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx \
  TWILIO_AUTH_TOKEN=your_auth_token_here \
  TWILIO_FROM_NUMBER=+14155550100
```

Replace the values with your actual credentials from Step 1.

### Step 4 — Run the database migration

**Option A — Supabase CLI:**
```bash
supabase db push
```

**Option B — Supabase dashboard (no CLI needed):**
1. Go to https://supabase.com/dashboard → your project → SQL Editor
2. Open `supabase/migrations/20260420000000_messages_outbound.sql`
3. Paste the contents and click Run

### Step 5 — Deploy the Edge Function

```bash
supabase functions deploy send-sms
```

### Step 6 — Deploy the DCC UI

The Messages tab is already in `index.html`. Push to main:
```bash
git add -A && git commit -m "Phase 0: SMS messaging" && git push origin main
```

GitHub Pages rebuilds in ~30 seconds.

### Step 7 — Send a test message

1. Open the live DCC site
2. Open any deal
3. Click the **Messages** tab
4. Enter Justin's or Nathan's verified number (e.g. `+16145550001`)
5. Type `test` and click **Send Text**
6. Confirm the text arrives on the phone

---

## Rollback

If anything goes wrong, undo cleanly:

```bash
# Remove the Edge Function
supabase functions delete send-sms

# Drop the table (run in Supabase SQL Editor)
# drop table if exists public.messages_outbound;
```

The DCC UI will gracefully show nothing if the table doesn't exist.

---

## Phase 1 preview

Once Phase 0 is confirmed working, the next steps are:
- Upgrade Twilio to paid, register A2P 10DLC brand + campaign
- Port the 3 GHL numbers (Justin's, Eric's VA line, outreach rotation)
- Add inbound SMS, call recording, compliance middleware
- Keep GHL running in parallel until port completes
