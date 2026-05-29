# Release contracts

A **contract** declares everything that must be true for a capability to work -
across every layer, not just code. Certs, third-party credentials, secrets,
edge-function deploys, and live runtime state are all links in the chain. Code
is only one of them.

The `release-readiness` agent reads a contract, checks every link, and returns
**GO / NO-GO / NEEDS-HUMAN** with evidence per link. A build is GO only when
every `pre_build` link is VERIFIED.

## Why this exists

Inbound calls broke at Build 14 and stayed broken through Build 22 - eight
builds - because nobody had the dependency chain written down. Each session
re-discovered the chain and fixed one broken link per build. A contract makes
the whole chain visible at once, so you fix every broken link before spending a
build credit and a multi-hour Apple wait.

## How to use it

```
/release-check inbound-callkit          # pre-build: everything checkable from here
/release-check inbound-callkit --post    # post-build: runtime registration, after install
```

Or just ask: "is inbound-callkit ready to build?" / "what's blocking <feature>?"

## The one rule that matters

**"I couldn't check it" is NOT a pass.** Every link gets one of three verdicts:

- **VERIFIED** - actually checked, with evidence (a value, timestamp, API response)
- **BROKEN** - checked, it's wrong (with the fix + who can do it)
- **NEEDS-HUMAN** - couldn't check (no Apple login, no API key) - flagged loudly

A green light the agent didn't earn is worse than no agent.

## Contract file format

YAML. Each contract has `feature`, `goal`, `owner`, a list of `links`, and a
`decision_rule`. Each link has:

| field | meaning |
|---|---|
| `id` | short stable identifier |
| `layer` | where it lives (app.json / apple / twilio / supabase / runtime) |
| `phase` | `pre_build` (checkable before a build) or `post_build` (needs install) |
| `verifiable_from_here` | `true` / `false` / `partial` - can the agent check it without a human? |
| `description` | what must be true, plain language |
| `check` | how to verify it (which tool, which query) |
| `pass_when` | the exact passing condition |
| `fix` | how to fix it if broken, and who can |
| `owner` | who fixes: claude / justin / nathan / justin_or_nathan |

## Candidate contracts to add

The pattern generalizes past mobile - any capability that depends on external
state that code can't see:

- `push-notifications` - Expo push token + APNs key + notification permissions
- `magic-link-auth` - Supabase auth redirect URLs + email deliverability
- `esignatures-send` - eSignatures.com API key + template IDs + webhook URL
- `outbound-sms` - A2P campaign state + mac_bridge online + phone_numbers gateway row
- `client-portal-access` - RLS policies + client_access rows + handle_new_user trigger

Each new failure mode adds a link to the relevant contract. Contracts are living
docs - when something breaks in a way no link caught, add the link.
