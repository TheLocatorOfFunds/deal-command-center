#!/usr/bin/env node
/**
 * DCC iMessage Bridge
 * Runs on the Mac Mini under Nathan's business Apple ID user account.
 *
 * INBOUND  — polls chat.db every 5s, syncs new messages to messages_outbound
 * OUTBOUND — polls Supabase for status='pending_mac', sends via Messages.app AppleScript
 *
 * Requirements:
 *   - Node.js installed, `npm install` run in this directory
 *   - .env file with SUPABASE_SERVICE_KEY set
 *   - Terminal granted Full Disk Access (System Settings → Privacy & Security)
 *   - Messages.app open and signed into Nathan's business Apple ID
 *   - Nathan's iPhone SMS Forwarding enabled to this Mac
 */

require('dotenv').config();
const Database   = require('better-sqlite3');
const { createClient } = require('@supabase/supabase-js');
const { execFileSync } = require('child_process');
const path       = require('path');
const os         = require('os');
const fs         = require('fs');

// ─── Config ──────────────────────────────────────────────────────────────────

const NATHAN_NUMBER  = '+15135162306';
const SUPABASE_URL   = 'https://rcfaashkfpurkvtmsmeb.supabase.co';
const SERVICE_KEY    = process.env.SUPABASE_SERVICE_KEY;
const CHAT_DB_PATH   = path.join(os.homedir(), 'Library/Messages/chat.db');
const WATERMARK_FILE = path.join(__dirname, '.watermark');
const POLL_MS        = 5000;
const APPLE_EPOCH    = 978307200; // Jan 1 2001 in Unix seconds

// ─── Startup checks ──────────────────────────────────────────────────────────

if (!SERVICE_KEY) {
  console.error('❌  SUPABASE_SERVICE_KEY not set. Copy .env.example → .env and add the key.');
  process.exit(1);
}
if (!fs.existsSync(CHAT_DB_PATH)) {
  console.error(`❌  chat.db not found at ${CHAT_DB_PATH}`);
  console.error('    Open Messages.app and make sure it is signed in.');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY);

console.log('✅  DCC iMessage Bridge starting');
console.log(`    Nathan : ${NATHAN_NUMBER}`);
console.log(`    DB     : ${CHAT_DB_PATH}`);
console.log(`    Poll   : ${POLL_MS / 1000}s`);
console.log('');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizePhone(raw) {
  if (!raw) return null;
  if (String(raw).includes('@')) return null; // skip email iMessage handles
  const d = String(raw).replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return raw;
}

function appleTs(nanos) {
  return new Date((nanos / 1e9 + APPLE_EPOCH) * 1000).toISOString();
}

function getWatermark() {
  try { return parseInt(fs.readFileSync(WATERMARK_FILE, 'utf8').trim(), 10) || 0; }
  catch { return 0; }
}
function saveWatermark(rowid) { fs.writeFileSync(WATERMARK_FILE, String(rowid)); }

// ─── Outbound: send via Messages.app AppleScript ─────────────────────────────

function sendViaMessages(toPhone, body) {
  // Use osascript -e flags to avoid buddy-lookup timeouts.
  // We open/create the chat by phone number, then send — this works even
  // when the recipient isn't in the Mac's Contacts / buddy list.
  const escaped = body.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const lines = [
    'tell application "Messages"',
    '  activate',
    `  set targetPhone to "${toPhone}"`,
    '  set targetService to 1st service whose service type = iMessage',
    '  set targetBuddy to participant targetPhone of targetService',
    `  send "${escaped}" to targetBuddy`,
    'end tell',
  ];

  const tmpPath = `/tmp/dcc_send_${Date.now()}.applescript`;
  fs.writeFileSync(tmpPath, lines.join('\n'));
  try {
    execFileSync('osascript', [tmpPath], { timeout: 30000 });
  } finally {
    fs.unlinkSync(tmpPath);
  }
}

async function processPendingOutbound() {
  const { data: pending, error } = await sb
    .from('messages_outbound')
    .select('id, to_number, body')
    .eq('status', 'pending_mac')
    .eq('from_number', NATHAN_NUMBER);

  if (error) { console.error('⚠️  pending_mac query error:', error.message); return; }
  if (!pending || pending.length === 0) return;

  for (const msg of pending) {
    try {
      sendViaMessages(msg.to_number, msg.body);
      await sb.from('messages_outbound').update({ status: 'sent' }).eq('id', msg.id);
      const preview = msg.body.length > 60 ? msg.body.slice(0, 57) + '…' : msg.body;
      console.log(`⬆ SENT  ${msg.to_number}  "${preview}"`);
    } catch (err) {
      await sb.from('messages_outbound')
        .update({ status: 'failed', error_message: err.message })
        .eq('id', msg.id);
      console.error(`❌ FAIL  ${msg.to_number}  ${err.message}`);
    }
  }
}

// ─── Inbound: sync chat.db → Supabase ────────────────────────────────────────

async function syncFromChatDb() {
  let db;
  try {
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
        m.associated_message_type,
        h.id            AS contact_id,
        c.chat_identifier,
        c.style         AS chat_style
      FROM message m
      LEFT JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
      LEFT JOIN chat              c   ON cmj.chat_id = c.ROWID
      LEFT JOIN handle            h   ON m.handle_id = h.ROWID
      WHERE m.ROWID > ?
        AND m.text IS NOT NULL
        AND m.text != ''
        AND c.style != 45                   -- skip group chats (style 43 = 1:1, 45 = group)
        AND (m.associated_message_type IS NULL
             OR m.associated_message_type = 0
             OR m.associated_message_type NOT BETWEEN 2000 AND 2099)  -- skip tapback reactions
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

    // Extra runtime guard: skip if chat_identifier looks like a group GUID (not a phone)
    const chatId = row.chat_identifier || '';
    if (chatId.startsWith('chat') && !/^\+?\d/.test(chatId)) {
      console.log(`⏭ SKIP group chat  guid=${row.guid}  chat=${chatId}`);
      continue;
    }

    // Determine the "other party" phone.
    // For outbound (is_from_me=1): chat_identifier is the recipient's phone.
    // For inbound (is_from_me=0): handle.id is the sender's phone.
    const contactPhone = normalizePhone(
      row.is_from_me === 1 ? row.chat_identifier : (row.contact_id || row.chat_identifier)
    );
    if (!contactPhone) continue;

    const isInbound = row.is_from_me === 0;
    const guid      = `imsg_${row.guid}`;

    const { error } = await sb.from('messages_outbound').upsert({
      to_number:   isInbound ? NATHAN_NUMBER : contactPhone,  // "to" = message destination
      from_number: isInbound ? contactPhone  : NATHAN_NUMBER, // "from" = actual sender
      body:        row.text,
      direction:   isInbound ? 'inbound' : 'outbound',
      status:      isInbound ? 'received' : 'sent',
      channel:     'imessage',
      twilio_sid:  guid,
      created_at:  appleTs(row.date),
    }, { onConflict: 'twilio_sid', ignoreDuplicates: true });

    if (error) {
      console.error(`⚠️  Supabase error (${guid}):`, error.message);
    } else {
      const dir     = isInbound ? '⬇ IN ' : '⬆ OUT';
      const preview = row.text.length > 60 ? row.text.slice(0, 57) + '…' : row.text;
      console.log(`${dir}  ${contactPhone}  "${preview}"`);
    }
  }

  saveWatermark(maxRowid);
}

// ─── Main loop ────────────────────────────────────────────────────────────────

async function tick() {
  await processPendingOutbound(); // send any queued DCC → Messages.app
  await syncFromChatDb();         // pull new messages from Messages.app → DCC
}

(async () => {
  await tick();
  setInterval(tick, POLL_MS);
})();
