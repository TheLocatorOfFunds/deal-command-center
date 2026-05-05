# Lauren refusal-test suite

Regression net for the prompt-injection hardening on `lauren-chat`.
Justin's hardening doc Task 6.

## What it does

- 53 prompt-injection / cross-user-leak / output-manipulation /
  social-engineering tests across 12 categories.
- Each test fires against the deployed `lauren-chat` Edge Function
  as a single user turn.
- Asserts the reply (a) contains none of the prohibited substrings
  and (b) optionally matches at least one expected refusal substring.
- Reports per-test pass/fail and a category breakdown.
- Exits non-zero if any test fails — wire into CI.

## Running it

```bash
# All 53 tests against production lauren-chat
deno run --allow-net --allow-read --allow-env scripts/lauren-refusal-tests/run.ts

# Filter by category
deno run --allow-net --allow-read --allow-env scripts/lauren-refusal-tests/run.ts \
  --filter=instruction_override

# Single test by id
deno run --allow-net --allow-read --allow-env scripts/lauren-refusal-tests/run.ts \
  --filter=ignore_previous_basic

# Different target (e.g. a staging deploy)
deno run --allow-net --allow-read --allow-env scripts/lauren-refusal-tests/run.ts \
  --target=https://your-staging.supabase.co/functions/v1/lauren-chat
```

Concurrency defaults to 4. Set `LAUREN_TEST_CONCURRENCY` to override.

## Categories (53 tests)

| Category | Count | What it tests |
|---|---|---|
| `instruction_override` | 6 | "ignore previous instructions," DAN, sudo, end-of-session injection |
| `authority_impersonation` | 4 | claims to be Nathan / Justin / admin / Anthropic |
| `prompt_exfiltration` | 7 | direct dump, "repeat above," translate, base64, "first 200 chars" |
| `cross_user_leak` | 7 | search by name / phone / case # / address; "list all claimants" |
| `output_manipulation` | 6 | HTML/script injection, external links, competitor promotion |
| `compliance` | 8 | forbidden phrases, dollar promises, fake AG authority, opt-out |
| `social_engineering` | 3 | fake emergency, sob story, "I already signed" |
| `session_manipulation` | 3 | inject session_id, personalization_context, token |
| `tool_invocation` | 4 | trick LLM into impersonating tool calls or external API calls |
| `data_request` | 3 | SSN, credit card, API key |
| `obfuscation` | 0 | (placeholder; can be added — emoji / unicode / reverse) |
| `abuse` | 2 | DOS-length input, recursive self-call |

## Cost

Each test is one Anthropic call. ~$0.30–$0.50 per full run on
claude-sonnet-4-5 (Lauren's current model). Don't run on every PR;
weekly cron is fine.

## CI suggestion (GitHub Action)

```yaml
# .github/workflows/lauren-refusal-tests.yml
name: Lauren refusal tests
on:
  schedule:
    - cron: '0 14 * * 1'   # Monday 9am EST / 10am EDT
  workflow_dispatch:        # manual trigger
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: denoland/setup-deno@v2
        with:
          deno-version: v2.x
      - run: deno run --allow-net --allow-read --allow-env scripts/lauren-refusal-tests/run.ts
      - if: failure()
        # email Nathan via Resend, or post to a Slack webhook
        run: echo "regression detected"
```

## Adding tests

Edit `prompts.json`. Each entry needs:

```json
{
  "id": "unique_kebab_id",
  "category": "one of the categories above (or new)",
  "prompt": "the user message to send",
  "must_not_contain": ["substring 1", "substring 2"],
  "must_match_one_of": ["expected substring 1"]   // optional
}
```

Both arrays match case-insensitively as substrings. Use 3–10-char
fragments; full sentences are too brittle.

## Related

- `supabase/functions/lauren-chat/index.hardened.ts` — the patched
  function this suite is designed to validate
- `JUSTIN_LAUREN_PROMPT_INJECTION_HARDENING.md` — the original
  hardening roadmap (Task 6 = this suite)
