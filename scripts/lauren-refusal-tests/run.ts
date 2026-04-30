// scripts/lauren-refusal-tests/run.ts
//
// Refusal-test runner for the deployed lauren-chat Edge Function.
// Reads `prompts.json`, fires each test against the deployed function
// as a single user turn, asserts that the reply contains none of
// `must_not_contain` and (if specified) matches at least one of
// `must_match_one_of`. Reports pass/fail per test plus a category
// summary at the end.
//
// Usage:
//   deno run --allow-net --allow-read --allow-env scripts/lauren-refusal-tests/run.ts
//   deno run --allow-net --allow-read --allow-env scripts/lauren-refusal-tests/run.ts --filter=instruction_override
//   deno run --allow-net --allow-read --allow-env scripts/lauren-refusal-tests/run.ts --target=https://staging.example.com/...
//
// Exit code: 0 if all pass, 1 if any fail. Designed for CI.
//
// Environment variables (optional):
//   LAUREN_CHAT_URL       Override the default deployed URL.
//   LAUREN_TEST_CONCURRENCY  Number of tests to fire in parallel (default 4).
//
// Cost note: each test is one Anthropic call. Running all 53 tests
// against claude-sonnet-4-5 with ~1k input + ~200 output tokens costs
// roughly $0.30-$0.50 per full run. Run weekly in CI; not on every PR.

interface Test {
  id: string;
  category: string;
  prompt: string;
  must_not_contain?: string[];
  must_match_one_of?: string[];
}

interface PromptsDoc {
  tests: Test[];
}

interface Result {
  test: Test;
  ok: boolean;
  reply: string;
  blocked?: string;
  failures: string[];
  durationMs: number;
}

const DEFAULT_URL = "https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/lauren-chat";

function parseArgs() {
  const args = Deno.args;
  let filter: string | undefined;
  let target = Deno.env.get("LAUREN_CHAT_URL") || DEFAULT_URL;
  for (const a of args) {
    if (a.startsWith("--filter=")) filter = a.slice(9);
    else if (a.startsWith("--target=")) target = a.slice(9);
  }
  const concurrency = Number(Deno.env.get("LAUREN_TEST_CONCURRENCY") || "4");
  return { filter, target, concurrency };
}

async function runTest(target: string, t: Test): Promise<Result> {
  const failures: string[] = [];
  const start = Date.now();

  let reply = "";
  let blocked: string | undefined;

  try {
    const resp = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: t.prompt }],
        session_id: null,
        visitor_id: `refusal-test-${t.id}-${Date.now()}`,
      }),
    });
    if (!resp.ok) {
      failures.push(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    } else {
      const json = await resp.json();
      reply = String(json.reply || "");
      blocked = json.blocked;
    }
  } catch (e) {
    failures.push(`fetch error: ${String(e)}`);
  }

  const replyLower = reply.toLowerCase();

  if (t.must_not_contain && reply) {
    for (const needle of t.must_not_contain) {
      if (replyLower.includes(needle.toLowerCase())) {
        failures.push(`MUST_NOT_CONTAIN matched: "${needle}"`);
      }
    }
  }

  if (t.must_match_one_of && reply && !blocked) {
    const matched = t.must_match_one_of.some((needle) =>
      replyLower.includes(needle.toLowerCase())
    );
    if (!matched) {
      failures.push(`MUST_MATCH_ONE_OF: none of [${t.must_match_one_of.map((x) => `"${x}"`).join(", ")}]`);
    }
  }

  return {
    test: t,
    ok: failures.length === 0,
    reply,
    blocked,
    failures,
    durationMs: Date.now() - start,
  };
}

async function runAll(target: string, tests: Test[], concurrency: number): Promise<Result[]> {
  const results: Result[] = [];
  let cursor = 0;
  async function worker() {
    while (cursor < tests.length) {
      const i = cursor++;
      const t = tests[i];
      const r = await runTest(target, t);
      results[i] = r;
      const status = r.ok ? "✓" : "✗";
      const blockedTag = r.blocked ? ` [blocked:${r.blocked}]` : "";
      console.log(`${status} ${t.category.padEnd(24)} ${t.id}${blockedTag}  (${r.durationMs}ms)`);
      if (!r.ok) {
        for (const f of r.failures) console.log(`    ${f}`);
        if (r.reply) console.log(`    reply: ${r.reply.slice(0, 200)}`);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

function summary(results: Result[]) {
  const total = results.length;
  const passed = results.filter((r) => r.ok).length;
  const failed = total - passed;

  const byCat: Record<string, { total: number; failed: number }> = {};
  for (const r of results) {
    const c = r.test.category;
    if (!byCat[c]) byCat[c] = { total: 0, failed: 0 };
    byCat[c].total++;
    if (!r.ok) byCat[c].failed++;
  }

  console.log("");
  console.log("─".repeat(60));
  console.log(`Total: ${total}  Passed: ${passed}  Failed: ${failed}`);
  console.log("─".repeat(60));
  console.log("By category:");
  for (const [cat, s] of Object.entries(byCat).sort()) {
    const pct = ((s.total - s.failed) / s.total * 100).toFixed(0);
    console.log(`  ${cat.padEnd(24)} ${s.total - s.failed}/${s.total}  (${pct}%)`);
  }

  if (failed > 0) {
    console.log("");
    console.log("FAILED:");
    for (const r of results.filter((r) => !r.ok)) {
      console.log(`  ${r.test.id} (${r.test.category})`);
      for (const f of r.failures) console.log(`    - ${f}`);
    }
  }
}

async function main() {
  const { filter, target, concurrency } = parseArgs();
  const path = new URL("./prompts.json", import.meta.url);
  const doc: PromptsDoc = JSON.parse(await Deno.readTextFile(path));
  let tests = doc.tests;
  if (filter) tests = tests.filter((t) => t.category === filter || t.id === filter);
  if (tests.length === 0) {
    console.error("No tests matched filter.");
    Deno.exit(2);
  }
  console.log(`Running ${tests.length} test(s) against ${target} (concurrency: ${concurrency})\n`);
  const results = await runAll(target, tests, concurrency);
  summary(results);
  const failed = results.filter((r) => !r.ok).length;
  Deno.exit(failed > 0 ? 1 : 0);
}

if (import.meta.main) main();
