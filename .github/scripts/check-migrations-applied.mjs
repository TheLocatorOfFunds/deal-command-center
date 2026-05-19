#!/usr/bin/env node
/**
 * Migrations drift check.
 *
 * Compares the .sql files in supabase/migrations/ against the migrations
 * actually applied to the prod Supabase project. Fails (exit 1) when any
 * committed migration has not been applied — that means a PR shipped UI
 * code that depends on a column / RPC / table that doesn't exist in prod
 * yet, which is exactly how 2026-05-07 broke the entire DCC for ~30
 * minutes (Nathan's soft-delete PR shipped `WHERE deleted_at IS NULL`
 * UI but the column was never added).
 *
 * Reads SUPABASE_PAT (Personal Access Token from Supabase dashboard →
 * Account → Access Tokens) and SUPABASE_PROJECT_REF (defaults to the
 * RefundLocators project). Hits the Supabase Management API:
 *
 *   GET https://api.supabase.com/v1/projects/{ref}/database/migrations
 *
 * Naming model:
 * - Committed file:  `YYYYMMDDHHMMSS_some_name.sql`
 * - Applied record:  `{ version: "YYYYMMDDHHMMSS", name: "some_name" }`
 *
 * Quirks this handles:
 * - When `mcp__supabase__apply_migration` is called, it stamps the apply
 *   timestamp as the version, NOT the file's prefix. So matching by
 *   version alone misses things. We match by `name` (post-prefix) and
 *   normalize both sides by stripping any leading 14-digit prefix.
 * - Some applied names are `20260506000000_docusign_envelopes` (with a
 *   prefix baked into the name). normalizeName() strips that.
 * - Files that don't match the `\d{14}_*.sql` pattern are skipped — they
 *   aren't migrations.
 */

import { readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF || 'rcfaashkfpurkvtmsmeb';
const PAT = process.env.SUPABASE_PAT;

if (!PAT) {
  console.error('❌ SUPABASE_PAT secret is not set.');
  console.error('');
  console.error('Generate a Personal Access Token at:');
  console.error('  https://supabase.com/dashboard/account/tokens');
  console.error('Then add it as a repo secret named SUPABASE_PAT:');
  console.error('  Settings → Secrets and variables → Actions → New repository secret');
  process.exit(2);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(__dirname, '../../supabase/migrations');

const FILENAME_RE = /^(\d{14})_(.+)\.sql$/;

const committed = readdirSync(migrationsDir)
  .map((f) => {
    const m = FILENAME_RE.exec(f);
    if (!m) return null;
    return { file: f, version: m[1], name: m[2] };
  })
  .filter(Boolean);

console.log(`Committed migrations in supabase/migrations/: ${committed.length}`);

let applied;
try {
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/migrations`,
    { headers: { Authorization: `Bearer ${PAT}`, Accept: 'application/json' } },
  );
  if (!res.ok) {
    const body = await res.text();
    console.error(`❌ Supabase Management API returned ${res.status}.`);
    console.error(`   Endpoint: GET /v1/projects/${PROJECT_REF}/database/migrations`);
    console.error(`   Response: ${body.slice(0, 500)}`);
    if (res.status === 401 || res.status === 403) {
      console.error('');
      console.error('Auth failed. Verify SUPABASE_PAT is a valid Personal Access Token');
      console.error('and that the token owner has access to the project.');
    }
    process.exit(2);
  }
  applied = await res.json();
} catch (err) {
  console.error(`❌ Failed to reach Supabase Management API: ${err.message}`);
  process.exit(2);
}

if (!Array.isArray(applied)) {
  console.error('❌ Unexpected response shape from Supabase API (expected array of migrations).');
  console.error(`   Got: ${JSON.stringify(applied).slice(0, 300)}`);
  process.exit(2);
}

console.log(`Applied migrations on prod (project ${PROJECT_REF}): ${applied.length}`);

const stripPrefix = (n) => String(n).replace(/^\d{14}_/, '');
const appliedNames = new Set(applied.map((m) => stripPrefix(m.name)));

const missing = committed.filter((c) => !appliedNames.has(c.name));

if (missing.length === 0) {
  console.log('');
  console.log(`✅ All ${committed.length} committed migrations are applied to prod.`);
  process.exit(0);
}

console.error('');
console.error(`❌ Migration drift detected — ${missing.length} committed file(s) NOT applied to prod:`);
console.error('');
for (const m of missing) {
  console.error(`   • ${m.file}`);
}
console.error('');
console.error('How to fix:');
console.error(`  1. Open Supabase SQL Editor: https://supabase.com/dashboard/project/${PROJECT_REF}/sql/new`);
console.error('  2. Paste each missing file\'s contents and click Run');
console.error('  3. Push a new commit (or re-run this workflow) to confirm green');
console.error('');
console.error('Why this matters: shipping UI that depends on schema changes BEFORE');
console.error('applying the migration breaks production for everyone the moment the');
console.error('PR merges. See CLAUDE.md → Migration protocol for the full convention.');
process.exit(1);
