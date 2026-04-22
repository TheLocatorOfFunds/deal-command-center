#!/usr/bin/env node
/**
 * DCC iMessage Bridge
 * Runs on the Mac Mini under Nathan's business Apple ID user account.
 *
 * What it does:
 *   - Every 5 seconds, reads ~/Library/Messages/chat.db for new messages
 *   - Inbound  (someone texted Nathan): inserts into messages_outbound as direction='inbound'
 *   - Outbound (Nathan texted someone):  inserts into messages_outbound as direction='outbound'
 *   - Deduplicates using the message guid so restarts are safe
 *
 * Requirements:
 *   - Node.js installed
 *   - `npm install` run in this directory
 *   - .env file with SUPABASE_SERVICE_KEY set
 *   - Terminal (or node binary) granted Full Disk Access in System Settings
 *   - Messages.app open and signed into Nathan's business Apple ID
 *   - Nathan's iPhone SMS Forwarding enabled to this Mac
 */

require('dotenv').config();
const Database  = require('better-sqlite3');
const { createClient } = require('@supabase/supabase-js');
const { execSync } = require('child_process');
const path      = require('path');
const os        = require('os');
const fs        = require('fs');

// ─── Config ──────────────────────────────────────────────────────────────────

const NATHAN_NUMBER   = '+15135162306';
const SUPABASE_URL    = 'https://rcfaashkfpurkvtmsmeb.supabase.co';
const SERVICE_KEY     = process.env.SUPABASE_SERVICE_KEY;
const CHAT_DB_PATH    = path.join(os.homedir(), 'Library/Messages/chat.db');
const WATERMARK_FILE  = path.join(__dirname, '.watermark');
const POLL_MS         = 5000;

// Apple's epoch starts Jan 1 2001 — offset from Unix epoch (Jan 1 1970)
const APPLE_EPOCH_OFFSET = 978307200;

// ─── Startup checks ──────────────────────────────────────────────────────────

if (!SERVICE_KEY) {
  console.error('❌  SUPABASE_SERVICE_KEY is not set. Copy .env.example to .env and add the key.');
  process.exit(1);
}

if (!fs.existsSync(CHAT_DB_PATH)) {
  console.error(`❌  chat.db not found at ${CHAT_DB_PATH}`);
  console.error('    Make sure Messages.app is open and signed in on this Mac.');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY);

console.log('✅  DCC iMessage Bridge starting');
console.log(`    Nathan's number : ${NATHAN_NUMBER}`);
console.log(`    chat.db         : ${CHAT_DB_PATH}`);
console.log(`    Poll interval   : ${POLL_MS / 1000}s`);
console.log('');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizePhone(raw) {
  if (!raw) return null;
  // Strip everything except digits
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  // email addresses (iMessage handles) — skip
  if (String(raw).includes('@')) return null;
  return raw;
}

function appleTs(nanos) {
  // chat.db stores timestamps as nanoseconds since Apple epoch
  return new Date((nanos / 1e9 + APPLE_EPOCH_OFFSET) * 1000).toISOString();
}

function getWatermark() {
  try { return parseInt(fs.readFileSync(WATERMARK_FILE, 'utf8').trim(), 10) || 0; }
  catch { return 0; }
}

function saveWatermark(rowid) {
  fs.writeFileSync(WATERMARK_FILE, String(rowid));
}

// ─── Core sync ───────────────────────────────────────────────────────────────

async function poll() {
  let db;
  try {
    // Open read-only so we never accidentally corrupt chat.db
    db = new Database(CHAT_DB_PATH, { readonly: true, fileMustExist: true });
  } catch (err) {
    console.error('⚠️  Cannot open chat.db:', err.message);
    console.error('   → Grant Full Disk Access to Terminal in System Settings → Privacy & Security');
    return;
  }

  const watermark = getWatermark();

  let rows;
  try {
    rows = db.prepare(`
      SELECT
        m.ROWID,
        m.guid,
        m.text,
        m.date,
        m.is_from_me,
        m.service,
        h.id   AS contact_id,
        c.chat_identifier
      FROM message m
      LEFT JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
      LEFT JOIN chat             c   ON cmj.chat_id = c.ROWID
      LEFT JOIN handle           h   ON m.handle_id = h.ROWID
      WHERE m.ROWID > ?
        AND m.text IS NOT NULL
        AND m.text != ''
      ORDER BY m.ROWID ASC
      LIMIT 100
    `).all(watermark);
  } finally {
    db.close();
  }

  if (rows.length === 0) return;

  let maxRowid = watermark;

  for (const row of rows) {
    maxRowid = Math.max(maxRowid, row.ROWID);

    // Resolve the contact's phone number
    const rawContact = row.contact_id || row.chat_identifier;
    const contactPhone = normalizePhone(rawContact);

    // Skip email-based iMessage handles (not SMS/phone)
    if (!contactPhone) continue;

    const isInbound = row.is_from_me === 0;
    const guid      = `imsg_${row.guid}`;   // unique key for dedup

    const record = {
      to_number:   isInbound ? contactPhone  : contactPhone,
      from_number: isInbound ? NATHAN_NUMBER : NATHAN_NUMBER,
      body:        row.text,
      direction:   isInbound ? 'inbound'     : 'outbound',
      status:      isInbound ? 'received'    : 'sent',
      twilio_sid:  guid,
      created_at:  appleTs(row.date),
      // deal_id will be null — DCC's 6s poll + smart routing will associate it
    };

    const { error } = await sb
      .from('messages_outbound')
      .upsert(record, { onConflict: 'twilio_sid', ignoreDuplicates: true });

    if (error) {
      console.error(`⚠️  Supabase insert error for ${guid}:`, error.message);
    } else {
      const dir   = isInbound ? '⬇ IN ' : '⬆ OUT';
      const other = contactPhone;
      const body  = row.text.length > 60 ? row.text.slice(0, 57) + '…' : row.text;
      console.log(`${dir}  ${other}  "${body}"`);
    }
  }

  saveWatermark(maxRowid);
}

// ─── Main loop ────────────────────────────────────────────────────────────────

(async () => {
  // Run once immediately, then on interval
  await poll();
  setInterval(poll, POLL_MS);
})();
