---
name: verify-feature
description: The evidence gate for the word "done". Before declaring ANY feature/fix done, gather evidence across the streams that apply (observed behavior, data shape, console/logs, runtime/integration signal, repeatability) and return DONE / NOT-DONE / INCONCLUSIVE with the evidence attached. The automation of CLAUDE.local.md Rule #1. Routes to the domain gates (web-qa-gate, verify-deploy, release-check --post). Use before saying "done / fixed / shipped / should work".
allowed-tools: Bash, Read, Grep, mcp__supabase__execute_sql, mcp__supabase__get_logs, mcp__supabase__list_edge_functions, mcp__Claude_in_Chrome__navigate, mcp__Claude_in_Chrome__read_page, mcp__Claude_in_Chrome__read_console_messages, mcp__Claude_in_Chrome__find, mcp__Claude_in_Chrome__computer
---

# verify-feature — never say "done" without evidence

## Why this exists
The single most repeated failure across this project (5/04 calls, 5/07 scroll,
5/13 links, 5/27 Build 14, 6/04 outbound): work declared "done / fixed /
shipped / should work" when all that actually happened was *the code was
written, the build finished, or the SQL ran* — none of which is evidence the
behavior works. Justin then discovered the breakage on a live test and had to
become the QA net ("Did you test this before you pushed it?" / "I don't trust
what you say anymore"). This skill makes "done" mean *verified with evidence*.
It is the generalization of `verify-deploy` (edge-function-only) to every kind
of change, and the executable form of CLAUDE.local.md Rule #1.

## When to invoke
- Before telling Justin a feature/fix is done, fixed, shipped, working.
- Before stamping a GitHub issue closed.
- Any time you're about to write "should work" — that phrase is the tell that
  you have a theory, not evidence.

## The five evidence streams
Not all apply to every change. Pick the ones that do; a DONE needs the
**behavior** stream PLUS at least one corroborating stream (data or runtime).

1. **Observed behavior** — the actual user-facing flow exercised end to end, in
   the real surface (browser / device / real send). The irreducible one.
2. **Data shape** — a query confirming the write/state landed:
   row exists, columns populated, recent timestamp, correct linkage.
3. **Console / logs clean** — no uncaught errors on the path
   (`read_console_messages onlyErrors`, or server/edge logs).
4. **Runtime / integration signal** — the cross-system proof:
   `voice_sdk_status=registered`, Twilio status `delivered`/`completed`,
   edge-fn deployed `updated_at` ≥ the commit, webhook 200.
5. **Repeatability** — a second run / a variation works; not a one-off fluke;
   no stuck spinner on the 2nd interaction; idempotent.

## Routing by change type (use the domain gate; don't reinvent it)
- **Web app** (`src/app.jsx` / `app.js` / `*.html`) → **/web-qa-gate**
  (Chrome QA on the touched flow + console-clean; writes the web-push marker).
  Streams 1, 3, 5.
- **Mobile** (calling / native) → **/release-check <feature> --post** after
  install; confirm `voice_sdk_status` / `call_logs` for the current build.
  Streams 1, 2, 4, 5. (Pre-build readiness is /release-check + /mobile-prebuild-gate.)
- **Edge function / comms** (send-sms, receive-sms, twilio-*, generate-*) →
  **/verify-deploy <fn>** (real scenario + DB query + delivery status).
  Streams 1, 2, 4.
- **DB / data / RLS** → query the resulting rows directly via Supabase MCP;
  for RLS, prove the scoped role sees exactly what it should and nothing more.
  Streams 2, plus behavior if a UI consumes it.

## Output format (evidence, not vibes)
```
=== verify-feature: <what> ===
Change under test: <commit/files or description>
Streams checked:
  [✓|✗|n/a] behavior     — <what was exercised, where, result>
  [✓|✗|n/a] data shape   — <query + actual rows>
  [✓|✗|n/a] console/logs — <clean? first error if not>
  [✓|✗|n/a] runtime      — <the cross-system signal + value>
  [✓|✗|n/a] repeatability— <2nd run / variation result>
Verdict: DONE | NOT-DONE | INCONCLUSIVE
If NOT-DONE: <exactly what's broken + where>
If INCONCLUSIVE: <the ONE thing only Justin can do (e.g. a live two-way call),
                 stated precisely — hand him that, do not call it done>
```

## Hard rules
- "I committed it" / "the build finished" / "the SQL ran" / "the deploy
  succeeded" are NOT evidence of working behavior. They don't earn a ✓ on the
  behavior stream.
- A DONE requires the behavior stream ✓ AND at least one of data/runtime ✓.
- If you cannot exercise the behavior yourself, the verdict is **INCONCLUSIVE**,
  never DONE. Hand Justin the single specific thing only a human can verify
  (a real audio call, a subjective UX call) — that's the only thing he should
  be the net for.
- Never upgrade INCONCLUSIVE to DONE to be helpful. That's the exact move this
  skill exists to stop.

## Anti-patterns this prevents
- "Should work now." (A theory wearing a verdict's clothes.)
- "Pushed the fix, you can test it." (Outsourcing verification to Justin.)
- Closing an issue on a green deploy log without exercising the path.
- Declaring a fix done while a spinner is still spinning.
