---
name: verify-deploy
description: After an Edge Function is deployed (Justin's deploy or ours), verify the deployed behavior matches expectations — don't trust "I committed the fix." Sends/queries a real test scenario, compares actual vs expected, returns SHIP / REGRESSION / INCONCLUSIVE. Use after any EF deploy that involves a code change, before declaring a fix "done" — especially for send-sms / generate-case-summary / receive-sms / any function with explicit code branches (gateway, channel, provider).
allowed-tools: Bash, Read, Grep
---

# Verify a Supabase Edge Function deploy actually changed prod behavior

## Why this exists
Twice today (`#235` send-sms iMessage fix, then again 2026-05-28 on the
Twilio fallback) we declared a fix "shipped" the moment the commit
landed, then learned Nathan was still hitting the same bug. Cause: the
deploy either covered only one branch of a two-branch function, or
hadn't taken effect on the live code path Nathan was actually using.

This skill closes that loop: trigger a real scenario, query the
resulting state, report whether the deployed function produces the
expected behavior.

## When to invoke
- Immediately after Justin deploys an EF we coordinated on
- Before stamping any GitHub issue closed when the fix lives in an EF
- Whenever Nathan says "did the fix actually work?"

## Inputs
- `function_name` (required) — e.g. `send-sms`, `generate-case-summary`,
  `receive-sms`, `relay-dispatcher`, `dispatch-cadence-message`
- `scenario` (optional, defaults per function) — what to test
- `expected` (optional, defaults per function) — what to look for

## Pre-flight
1. Confirm the function source on `main` matches what's expected:
   ```bash
   git log -1 --format='%H %s' supabase/functions/<function_name>/index.ts
   ```
2. Check the deployed function timestamp via Supabase Management API
   (read-only, no allowlist issue):
   ```bash
   PAT=$(jq -r '.mcpServers["supabase-dcc"].env.SUPABASE_ACCESS_TOKEN' \
     ~/Library/Application\ Support/Claude/claude_desktop_config.json)
   curl -s -H "Authorization: Bearer $PAT" \
     https://api.supabase.com/v1/projects/rcfaashkfpurkvtmsmeb/functions/<function_name> \
     | jq '.updated_at, .version'
   ```
   If `updated_at` is older than the commit on main, the deploy
   didn't take — STOP and tell the user before proceeding.

## Per-function verify recipes

### send-sms (gateway + split behavior)
**Test:** in the live tab via the page client, query the 5 most recent
`messages_outbound` rows grouped by `(to_number, created_at within 60s,
channel)`. Any row group with `count > 1` indicates a pre-split.

```js
const { data } = await sb.from('messages_outbound')
  .select('id, to_number, body, channel, created_at')
  .eq('direction', 'outbound')
  .order('created_at', { ascending: false })
  .limit(50);
// group + report any multi-segment groups on EITHER channel
```

**Expected:** no multi-segment groups in the last hour. If found,
identify the channel — that's the path that didn't take the fix.

**Bonus:** prompt the user to send a real 300-char test message to a
known team number on each gateway (Twilio + mac_bridge) and re-query.

### generate-case-summary (output shape + new signals)
**Test:** pick a known surplus deal with a non-null
`refundlocators_token` and existing link engagement. Invoke the EF for
that deal_id, read `deals.meta.case_intel_summary.text`.

**Expected:** text references the homeowner's link engagement or
Lauren chat history if either exists. Text names specific filings with
dollar amounts when they exist in `docket_events`. Generic phrases like
"court activity pending" are red flags — prompt the user to confirm
prompt rule is taking effect.

### receive-sms (inbound MMS attachment)
**Test:** query the 10 most recent inbound `messages_outbound` rows
with `media_url IS NOT NULL`. Compare attachment-bearing inbounds
against the `inbound-media` storage bucket.

**Expected:** every inbound with `cache_has_attachments` should have
a populated `media_url`. Mismatch → bridge or receive-sms didn't take
the fix.

## Output format
```
=== verify-deploy: <function_name> ===
Source-on-main: <commit-hash> <message>
Deployed-version: <timestamp> (delta from main: <X minutes/hours>)
Scenario: <what was tested>
Sample size: <N>
Findings:
  - <specific evidence>
Verdict: SHIP | REGRESSION | INCONCLUSIVE
If REGRESSION: <which branch / path / call site is broken>
If INCONCLUSIVE: <what's needed to verify (e.g. real test send)>
```

## When to fall back to "INCONCLUSIVE"
If you can only confirm "the commit is in the deployed source" but
cannot trigger or query a real scenario, output INCONCLUSIVE — never
output SHIP. Get the user to do a real test before declaring done.

## Anti-patterns this prevents
- "I committed the fix, it should work." (Today's send-sms case.)
- "The deploy log says successful, must be live." (Justin's PAT IP
  allowlist gotcha can produce silent partial deploys.)
- "I tested the new code path; the other path is unchanged." (Only
  partly true — gateway routing might've shifted, like PR #211.)
