#!/usr/bin/env node
//
// Smoke test for the lauren-voice Edge Function.
//
// What it does: synthesizes a Vapi-shaped Custom LLM request, posts it
// to your deployed lauren-voice endpoint, and reads the SSE stream
// back. Verifies the function is live, the auth secret is correct,
// the Anthropic key is set, and Lauren responds coherently.
//
// Run it AFTER deploying lauren-voice but BEFORE placing a real phone
// call. If the smoke test fails, the phone call will too — much faster
// to diagnose here than in the Vapi call log.
//
// Usage:
//   VAPI_LLM_SECRET=... node scripts/vapi-smoke-test.mjs
//
//   # Test with a specific caller phone (must exist in contacts to
//   # trigger the warm path)
//   VAPI_LLM_SECRET=...  CALLER_PHONE=+15135551234 \
//     node scripts/vapi-smoke-test.mjs
//
//   # Custom message instead of the default greeting
//   VAPI_LLM_SECRET=...  MESSAGE="Hi, I think my house was foreclosed last year." \
//     node scripts/vapi-smoke-test.mjs

import { env, exit, argv } from 'node:process';

const ENDPOINT = 'https://rcfaashkfpurkvtmsmeb.supabase.co/functions/v1/lauren-voice';
const SECRET = env.VAPI_LLM_SECRET;
const CALLER_PHONE = env.CALLER_PHONE || null;
const MESSAGE = env.MESSAGE || "Hi, I'm calling because I think my house was foreclosed on a few months ago.";

if (!SECRET) {
  console.error('VAPI_LLM_SECRET required (same value you pasted into Supabase Edge Function secrets).');
  exit(1);
}

// Synthesize a Vapi Custom LLM request body. Mimics what Vapi POSTs
// per turn: OpenAI Chat Completions format + Vapi metadata fields.
const requestBody = {
  model: 'claude-sonnet-4-5',
  stream: true,
  messages: [
    { role: 'user', content: MESSAGE },
  ],
  // Vapi-injected metadata. Defensive read in lauren-voice tries
  // multiple paths; this matches the most common shape per the docs.
  call: {
    id: 'smoke-test-' + Date.now(),
    customer: {
      number: CALLER_PHONE,
    },
  },
  customer: CALLER_PHONE ? { number: CALLER_PHONE } : undefined,
};

console.log(`POST ${ENDPOINT}`);
console.log(`Caller phone: ${CALLER_PHONE ?? '(unknown — testing cold path)'}`);
console.log(`Message: "${MESSAGE}"`);
console.log('---');

const startTime = Date.now();

const resp = await fetch(ENDPOINT, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${SECRET}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(requestBody),
});

console.log(`HTTP ${resp.status} ${resp.statusText} in ${Date.now() - startTime}ms`);
console.log(`Content-Type: ${resp.headers.get('content-type')}`);

if (!resp.ok) {
  const errText = await resp.text();
  console.error('\nERROR response body:');
  console.error(errText);
  console.error('\nDiagnosis:');
  if (resp.status === 401) {
    console.error('  - 401 Unauthorized → VAPI_LLM_SECRET in your env does not match what Supabase has set.');
    console.error('    Re-check: Supabase dashboard → Edge Functions → Secrets → VAPI_LLM_SECRET');
  } else if (resp.status === 503) {
    console.error('  - 503 Not Configured → either VAPI_LLM_SECRET or ANTHROPIC_API_KEY is missing in Supabase.');
    console.error('    Re-check: Supabase dashboard → Edge Functions → Secrets');
  } else if (resp.status === 404 || resp.status === 502) {
    console.error('  - Function not deployed, or deployed with the wrong name.');
    console.error('    Re-run: GitHub Actions → Deploy Edge Functions → lauren-voice');
  } else {
    console.error('  - Check the Edge Function logs in Supabase dashboard for the stack trace.');
  }
  exit(1);
}

if (!resp.body) {
  console.error('No response body — something is very wrong.');
  exit(1);
}

console.log('\nStreaming response:\n');

const reader = resp.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
let fullText = '';
let chunkCount = 0;
let firstChunkAt = null;

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split('\n');
  buffer = lines.pop() || '';
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('data: ')) continue;
    const payload = t.slice(6);
    if (!payload || payload === '[DONE]') continue;
    try {
      const chunk = JSON.parse(payload);
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.content) {
        if (!firstChunkAt) firstChunkAt = Date.now();
        chunkCount++;
        process.stdout.write(delta.content);
        fullText += delta.content;
      }
    } catch (_) {}
  }
}

const totalTime = Date.now() - startTime;
const ttft = firstChunkAt ? firstChunkAt - startTime : null;

console.log('\n\n---');
console.log(`✓ Stream complete.`);
console.log(`  chunks: ${chunkCount}`);
console.log(`  text length: ${fullText.length} chars`);
console.log(`  time to first chunk: ${ttft ?? '(none)'}ms`);
console.log(`  total time: ${totalTime}ms`);

if (totalTime > 5000) {
  console.warn(`\n⚠ Total time > 5s — Vapi voice turns will feel slow. Investigate before going live.`);
}
if (chunkCount === 0) {
  console.error(`\n✗ Zero chunks received. Function may not be wired to Anthropic correctly.`);
  exit(1);
}
if (fullText.length === 0) {
  console.error(`\n✗ Empty reply. Check Edge Function logs.`);
  exit(1);
}

console.log('\nNext step: place a real phone call to your Twilio number.');
