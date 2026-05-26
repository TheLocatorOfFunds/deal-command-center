#!/usr/bin/env node
//
// Vapi assistant creator — wraps the api.vapi.ai/assistant POST so Justin
// doesn't have to escape quotes in cURL JSON. Run with:
//
//   VAPI_PRIVATE_KEY=...  VAPI_LLM_SECRET=...  VAPI_WEBHOOK_SECRET=...  \
//     node scripts/vapi-create-assistant.mjs
//
// Or run interactively — missing env vars are prompted for.
//
// Idempotency: lists existing assistants first; if one named "Lauren —
// RefundLocators" already exists, prints its ID and exits. Use --force
// to create a new one anyway.
//
// Reads no credentials from disk and writes none back. Prints the
// created assistant JSON to stdout and stashes a copy at
// /tmp/vapi-assistant-<id>.json for reference.

import { randomBytes } from 'node:crypto';
import { stdin, stdout, exit, argv, env } from 'node:process';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';

const SUPABASE_PROJECT_REF = 'rcfaashkfpurkvtmsmeb';
const ASSISTANT_NAME = 'Lauren — RefundLocators';
const FORCE = argv.includes('--force');

async function prompt(question, { secret = false } = {}) {
  // Interactive prompt for missing env vars. Hides input when secret=true.
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  if (secret) {
    process.stdout.write(question);
    // Best-effort secret prompt: turn off echo if TTY.
    const wasRaw = stdin.isTTY ? stdin.isRaw : false;
    if (stdin.isTTY) stdin.setRawMode(true);
    let answer = '';
    for await (const chunk of stdin) {
      const ch = chunk.toString('utf8');
      if (ch === '\n' || ch === '\r' || ch === '') break;
      if (ch === '') { rl.close(); exit(130); }
      if (ch === '' || ch === '\b') {
        answer = answer.slice(0, -1);
      } else {
        answer += ch;
      }
    }
    if (stdin.isTTY) stdin.setRawMode(wasRaw);
    process.stdout.write('\n');
    rl.close();
    return answer.trim();
  }
  const answer = await rl.question(question);
  rl.close();
  return answer.trim();
}

async function readKey(envName, prompt_text, { secret = false, generate = false } = {}) {
  if (env[envName]) return env[envName];
  if (generate) {
    const value = randomBytes(32).toString('hex');
    console.log(`Generated ${envName}=${value}`);
    console.log(`(Save this — you'll paste it into Supabase Edge Function secrets too.)\n`);
    return value;
  }
  return await prompt(prompt_text, { secret });
}

function buildAssistantConfig(llmSecret, webhookSecret) {
  return {
    name: ASSISTANT_NAME,
    firstMessage: "Hi, this is Lauren with RefundLocators. How can I help you today?",
    firstMessageMode: 'assistant-speaks-first',
    maxDurationSeconds: 600,
    silenceTimeoutSeconds: 30,
    endCallMessage: "Thanks for calling. Take care.",
    voicemailMessage: null,
    backgroundSound: 'off',
    model: {
      provider: 'custom-llm',
      model: 'claude-sonnet-4-5',
      url: `https://${SUPABASE_PROJECT_REF}.supabase.co/functions/v1/lauren-voice`,
      headers: { Authorization: `Bearer ${llmSecret}` },
      temperature: 0.7,
      maxTokens: 256,
    },
    voice: {
      provider: '11labs',
      voiceId: '21m00Tcm4TlvDq8ikWAM', // Rachel — warm, mature female
      model: 'eleven_flash_v2_5',
      stability: 0.5,
      similarityBoost: 0.75,
      optimizeStreamingLatency: 3,
    },
    transcriber: {
      provider: 'deepgram',
      model: 'nova-2',
      language: 'en',
      endpointing: 300,
    },
    serverUrl: `https://${SUPABASE_PROJECT_REF}.supabase.co/functions/v1/vapi-webhook`,
    serverUrlSecret: webhookSecret,
    analysisPlan: {
      summaryPrompt: 'Summarize this call in 2 sentences for a CRM activity feed entry. Lead with whether the caller has a case with us, what they wanted, and what should happen next.',
      structuredDataPrompt: 'Extract these intake fields. Use null for fields not mentioned.',
      structuredDataSchema: {
        type: 'object',
        properties: {
          caller_name:      { type: 'string', description: "Caller's first and last name if they shared it." },
          county:           { type: 'string', description: 'Ohio county related to their foreclosure case.' },
          case_reference:   { type: 'string', description: 'Court case number if mentioned (e.g. 24CV1234).' },
          callback_number:  { type: 'string', description: 'Preferred callback number if different from the calling number.' },
          urgency:          { type: 'string', enum: ['low', 'normal', 'high'] },
          notes:            { type: 'string', description: 'Anything else the caller wants the team to know.' },
        },
      },
    },
  };
}

async function vapi(method, path, key, body) {
  const resp = await fetch(`https://api.vapi.ai${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!resp.ok) {
    throw new Error(`Vapi ${method} ${path} → ${resp.status}: ${text.slice(0, 400)}`);
  }
  return json;
}

async function main() {
  console.log('Vapi assistant creator for Lauren\n');

  const vapiKey      = await readKey('VAPI_PRIVATE_KEY',   'Vapi private API key: ', { secret: true });
  const llmSecret    = await readKey('VAPI_LLM_SECRET',    '', { generate: true });
  const webhookSecret = await readKey('VAPI_WEBHOOK_SECRET', 'Existing VAPI_WEBHOOK_SECRET from Supabase (or new random string): ', { secret: true });

  if (!vapiKey) { console.error('VAPI_PRIVATE_KEY required.'); exit(1); }
  if (!llmSecret) { console.error('VAPI_LLM_SECRET required.'); exit(1); }
  if (!webhookSecret) { console.error('VAPI_WEBHOOK_SECRET required.'); exit(1); }

  // ── Auth check + idempotency ─────────────────────────────────────
  console.log('\nListing existing assistants…');
  const existing = await vapi('GET', '/assistant?limit=100', vapiKey);
  const dupe = (Array.isArray(existing) ? existing : []).find(a => a?.name === ASSISTANT_NAME);
  if (dupe && !FORCE) {
    console.log(`\nAssistant "${ASSISTANT_NAME}" already exists.`);
    console.log(`  id:       ${dupe.id}`);
    console.log(`  created:  ${dupe.createdAt}`);
    console.log(`  modelUrl: ${dupe.model?.url ?? '(unknown)'}`);
    console.log(`\nRe-run with --force to create a duplicate, or edit the existing one in the Vapi dashboard.`);
    exit(0);
  }

  // ── Create ────────────────────────────────────────────────────────
  console.log(`\nCreating "${ASSISTANT_NAME}"…`);
  const config = buildAssistantConfig(llmSecret, webhookSecret);
  const created = await vapi('POST', '/assistant', vapiKey, config);

  const outPath = `/tmp/vapi-assistant-${created.id}.json`;
  writeFileSync(outPath, JSON.stringify(created, null, 2));

  console.log('\n✓ Created.');
  console.log(`  id:       ${created.id}`);
  console.log(`  name:     ${created.name}`);
  console.log(`  modelUrl: ${created.model?.url}`);
  console.log(`  saved to: ${outPath}`);

  console.log('\nNext steps:');
  console.log('  1. Supabase dashboard → Edge Functions → Secrets → add:');
  console.log(`       VAPI_LLM_SECRET=${llmSecret}`);
  console.log('     (and confirm VAPI_WEBHOOK_SECRET matches what you pasted above)');
  console.log('  2. Vapi dashboard → Phone Numbers → Import from Twilio → pick your inbound number');
  console.log(`       → assign assistant "${ASSISTANT_NAME}"`);
  console.log('  3. Copy the SIP URI Vapi gives you. Add it as Supabase secret VAPI_SIP_URI.');
  console.log('  4. GitHub Actions → Deploy Edge Functions → run with:');
  console.log('       lauren-voice twilio-voice-status');
  console.log('  5. Call your Twilio number from a personal phone. Verify per docs/VAPI_SETUP.md §6.');
}

main().catch(err => {
  console.error('\nFailed:', err.message);
  exit(1);
});
