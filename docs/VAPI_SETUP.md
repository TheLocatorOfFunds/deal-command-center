# Vapi voice agent setup — runbook

Last updated: 2026-05-26 — Justin's session, branch `claude/mobile-feature-parity-p3pPZ`.

This is the click-through guide for getting the Vapi-as-transport + Lauren-as-brain
voice agent live. The code side is committed (`lauren-voice` Edge Function + voicemail
fallback in `twilio-voice-status`). What's left is dashboard config + secrets + deploy.

## Architecture recap

```
Inbound call → Twilio number
  → twilio-voice (ring team's iPhone, ~10s)
  → if missed → twilio-voice-status TwiML
      → if VAPI_SIP_URI set:
          → <Dial timeout=10><Sip>vapi-uri</Sip>   (Lauren answers)
          → if Vapi no-answer in 10s:
              → <Say> + <Record>                    (voicemail fallback)
      → else:
          → <Say> + <Record>                        (voicemail today)

Per-turn during Vapi call:
  Vapi → POST /functions/v1/lauren-voice
       → translate OpenAI → Anthropic messages
       → look up caller phone → contact → deal → CASE_CONTEXT
       → stream Claude Sonnet 4.5 reply back as OpenAI SSE

End-of-call:
  Vapi → POST /functions/v1/vapi-webhook
       → store transcript + summary + intake in call_logs
       → push notification to team
```

## Step 1 — Vapi account (yours, ~3 min)

1. Sign up at https://dashboard.vapi.ai with `justin@fundlocators.com`
2. Add a credit card under **Billing**. Set a $50 spending cap initially
3. Go to **API Keys**, create a new **Private key** named "DCC server"
   — keep it; you'll paste it into the Supabase env vars below
   — and a **Public key** named "DCC client" (we don't need this yet but make it now)

## Step 2 — Create the Assistant

**Option A — paste-via-dashboard** (clicky, ~10 min):

1. Vapi → **Assistants** → **Create Assistant** → name: `Lauren — RefundLocators`
2. Tab **Model**:
   - Provider: **Custom LLM**
   - URL: `https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/lauren-voice`
   - Add header: `Authorization: Bearer <pick-a-strong-random-secret>`
     — save this string, it becomes `VAPI_LLM_SECRET` below
   - Model name (label only): `claude-sonnet-4-5`
   - Max tokens: 256
   - Temperature: 0.7
3. Tab **Voice**:
   - Provider: **ElevenLabs**
   - Voice: pick a warm female voice (audition: "Rachel" is the safe default)
   - Model: **Flash v2.5** (sub-second latency)
   - Stability: 0.5 / Similarity: 0.75
4. Tab **Transcriber**:
   - Provider: **Deepgram**, model **Nova-2**, language English
   - Endpointing: 300ms (default is fine)
5. Tab **Functions & Tools**: leave empty for v1 (no tool calls — Lauren responds from system prompt)
6. Tab **Advanced**:
   - First message (static): `Hi, this is Lauren with RefundLocators. How can I help you today?`
   - Max call duration: **10 minutes**
   - Silence timeout: 30 seconds
   - **Server URL** (end-of-call webhook): `https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/vapi-webhook`
   - Server URL header: `x-vapi-secret: <existing VAPI_WEBHOOK_SECRET value>`
7. **Save**

**Option B — `npm run vapi-create-assistant`** (recommended, ~30 sec):

```bash
npm run vapi-create-assistant
```

The script prompts for your Vapi private key + the existing `VAPI_WEBHOOK_SECRET`,
auto-generates a fresh `VAPI_LLM_SECRET`, checks for duplicate assistants (idempotent),
posts to api.vapi.ai, and prints the next-steps list including the exact env vars to
paste into Supabase. The full assistant config (model URL, headers, voice, transcriber,
structured-data schema for end-of-call analysis) is in `scripts/vapi-create-assistant.mjs`
— edit there if you want to change voice ID, temperature, etc.

**Option C — raw cURL** (if you don't want to run Node):

```bash
# Set these once
export VAPI_PRIVATE_KEY=<paste-your-key-from-step-1.3>
export VAPI_LLM_SECRET=$(openssl rand -hex 32)   # save this; goes into Supabase below
echo "VAPI_LLM_SECRET=$VAPI_LLM_SECRET (save me)"

# Create the assistant
curl -sS https://api.vapi.ai/assistant \
  -H "Authorization: Bearer $VAPI_PRIVATE_KEY" \
  -H "Content-Type: application/json" \
  -d @- <<JSON | tee /tmp/vapi-assistant.json
{
  "name": "Lauren — RefundLocators",
  "firstMessage": "Hi, this is Lauren with RefundLocators. How can I help you today?",
  "maxDurationSeconds": 600,
  "silenceTimeoutSeconds": 30,
  "model": {
    "provider": "custom-llm",
    "model": "claude-sonnet-4-5",
    "url": "https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/lauren-voice",
    "headers": { "Authorization": "Bearer $VAPI_LLM_SECRET" },
    "temperature": 0.7,
    "maxTokens": 256
  },
  "voice": {
    "provider": "11labs",
    "voiceId": "21m00Tcm4TlvDq8ikWAM",
    "model": "eleven_flash_v2_5",
    "stability": 0.5,
    "similarityBoost": 0.75
  },
  "transcriber": {
    "provider": "deepgram",
    "model": "nova-2",
    "language": "en"
  },
  "serverUrl": "https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/vapi-webhook",
  "serverUrlSecret": "<existing-VAPI_WEBHOOK_SECRET-from-supabase>"
}
JSON

# Note the "id" field returned — that's the assistantId you'll use in step 3.
ASSISTANT_ID=$(jq -r .id /tmp/vapi-assistant.json)
echo "ASSISTANT_ID=$ASSISTANT_ID"
```

If you go cURL: paste your `VAPI_PRIVATE_KEY` into the shell and the `serverUrlSecret`
field (current value of `VAPI_WEBHOOK_SECRET` from your Supabase dashboard), then run.

## Step 3 — Provision the SIP endpoint

The cleanest path is Vapi → **Phone Numbers** → **Import from Twilio**:

1. In Twilio Console: get your inbound number's SID (the number Lauren should answer
   when the team misses a call — typically `+15139985440` per the codebase)
2. Vapi: **Phone Numbers** → **Buy/Import** → **Import from Twilio**
3. Paste Twilio Account SID + Auth Token, pick the number from the list
4. Assign **Lauren — RefundLocators** as the inbound assistant
5. Vapi shows you a **SIP URI** — copy it. Looks like `sip:+15139985440@abc123.sip.vapi.ai`

Save the URI — it becomes `VAPI_SIP_URI` below.

> Note: importing means Vapi gets the rights to receive on this number via SIP.
> Your existing Twilio voice routing is unchanged — twilio-voice-status only
> hands the call to Vapi via SIP when the team misses the ring. Outbound
> SMS/voice continues to flow through your existing Mac Mini bridge.

## Step 4 — Supabase env vars (yours, ~2 min)

Supabase dashboard → **Project Settings** → **Edge Functions** → **Secrets**:

| Name | Value | Where it came from |
|---|---|---|
| `VAPI_LLM_SECRET` | The bearer secret from step 2 | You picked it or `openssl rand -hex 32` |
| `VAPI_SIP_URI` | `sip:+1...@...sip.vapi.ai` | Step 3 |
| `VAPI_WEBHOOK_SECRET` | (Already set from the `4b851be` commit) | Verify it exists; create if not |
| `ANTHROPIC_API_KEY` | (Already set; same as lauren-chat uses) | Verify it exists |

## Step 5 — Deploy the Edge Functions

Two functions need to deploy:
- `lauren-voice` (new — the Custom LLM endpoint)
- `twilio-voice-status` (modified — voicemail fallback after Vapi dial)

**Option A — GitHub Actions** (recommended):

1. GitHub → repo → **Actions** → **Deploy Edge Functions** → **Run workflow**
2. Branch: `main` (after merging this branch) or this feature branch for staging
3. Functions: `lauren-voice twilio-voice-status`
4. Verify JWT: `no`
5. Run. Watch the log for "All deploys complete."

**Option B — local CLI**:

```bash
supabase login   # uses your PAT from supabase.com/dashboard/account/tokens
supabase functions deploy lauren-voice --project-ref rcfaashkfpurkvtmsmeb --no-verify-jwt
supabase functions deploy twilio-voice-status --project-ref rcfaashkfpurkvtmsmeb --no-verify-jwt
```

## Step 6 — Test

**Cold path** (caller not in our system):

1. Use a phone whose number is NOT in `contacts` (your personal cell with caller ID blocked,
   or a friend's phone). Call your Twilio business line.
2. Let it ring past the team's iPhone (~10s).
3. Lauren should answer with the static "Hi, this is Lauren with RefundLocators..."
4. Try saying: "Hi, my name is Test Caller, I'm calling about a foreclosure."
5. Lauren should respond with a 1-2 sentence acknowledgment + a follow-up question
   (asking for your property address or county).
6. Hang up.

**Warm path** (caller IS in our system):

1. Use a phone whose number IS in `contacts` and linked to a deal.
2. Same flow.
3. Lauren should greet you by name and reference the case status.

**Verify in DCC**:

After hangup, check the `call_logs` table for the call:

```sql
select id, from_number, status, voice_provider, voice_call_id,
       length(voice_transcript) as transcript_len, voice_summary
from call_logs
order by created_at desc
limit 3;
```

You should see:
- `voice_provider = 'vapi'`
- `voice_call_id` populated (Vapi's UUID)
- `voice_transcript` is the full conversation
- `voice_summary` is Vapi's auto-generated summary

The team should also receive a "🤖 Agent intake: <caller>" push notification when
`voice_intake` populates (per the trigger in `20260523120200_push_notify_agent_intake.sql`).

## If something goes wrong

**Lauren doesn't answer (call drops or goes to voicemail immediately):**
- Vapi dashboard → Calls → Most recent → check for error
- Most likely: `VAPI_SIP_URI` typo, or the assistant isn't assigned to the phone number
- Voicemail still works (that's the failsafe) — check `call_logs.recording_url`

**Lauren answers but says "I'm having trouble":**
- Means `lauren-voice` returned an error
- Supabase dashboard → Edge Functions → lauren-voice → Logs
- Most likely: `VAPI_LLM_SECRET` mismatch between Vapi assistant config + Supabase env var

**Lauren rambles or breaks character:**
- The `VOICE_ADDENDUM` in `_shared/lauren-brain.ts` is what caps replies at 1-2 sentences
- If she's still long-winded, lower `maxTokens` in the assistant config from 256 → 150

**Cost runs higher than $0.25/min:**
- Check the cost breakdown in Vapi dashboard → Calls → Cost
- LLM cost is usually the swing; if it's >$0.10/min, lower `maxTokens` further or
  trim the system prompt (less likely to help — Lauren's prompt is already tight)
