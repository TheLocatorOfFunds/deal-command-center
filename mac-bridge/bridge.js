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
 *
 * Group chat routing logic
 * ─────────────────────────
 * For each chat guid seen, the bridge classifies it once and caches the result:
 *
 *   1:1 chat (style=43): chat_identifier IS the other party's phone.
 *      → look up deal via find_deal_by_phone RPC.
 *      → if no match, skip (unroutable number).
 *
 *   Group chat (style=45): chat_identifier is an opaque Apple GUID.
 *      → fetch all participant phones from chat_handle_join.
 *      → call find_deal_by_phone for every non-Nathan participant.
 *      → if ALL participants resolve to the SAME deal → route there.
 *      → if ANY participant is unknown (personal contact) → skip.
 *      → if participants split across multiple deals → skip (triage needed).
 *
 * This means: a group chat with (Nathan + brother + sister) where both are
 * contacts on deal X → syncs to deal X.  Nathan's personal family group →
 * skipped because the family members aren't DCC contacts.
 *
 * Since channel='imessage' rows bypass the tg_route_message_to_deal trigger
 * (by design, to prevent phone-match leaks), the bridge sets deal_id and
 * thread_key explicitly.
 *
 * Reactions (tapbacks)
 * ─────────────────────
 * Apple stores tapbacks with associated_message_type 2000-2005 and body text
 * like 'Liked "original"'.  The bridge syncs them as regular messages; the UI
 * renders them as compact reaction pills rather than full bubbles.
 */

require('dotenv').config();
const Database        = require('better-sqlite3');
const { createClient } = require('@supabase/supabase-js');
const { execFileSync } = require('child_process');
const path            = require('path');
const os              = require('os');
const fs              = require('fs');

// ─── Config ──────────────────────────────────────────────────────────────────

const NATHAN_NUMBER  = '+15135162306';
const SUPABASE_URL   = 'https://rcfaashkfpurkvtmsmeb.supabase.co';
const SERVICE_KEY    = process.env.SUPABASE_SERVICE_KEY;
const CHAT_DB_PATH   = path.join(os.homedir(), 'Library/Messages/chat.db');
const WATERMARK_FILE = path.join(__dirname, '.watermark');
const PID_FILE       = path.join(__dirname, '.bridge.pid');
const POLL_MS        = 5000;
const APPLE_EPOCH    = 978307200; // Jan 1 2001 in Unix seconds

// Reaction type → emoji mapping (Apple associated_message_type values)
const REACTION_EMOJI = { 2000: '👍', 2001: '❤️', 2002: '👎', 2003: '‼️', 2004: '❓', 2005: '😂' };

// ─── Startup checks ──────────────────────────────────────────────────────────

// ─── Single-instance lock ─────────────────────────────────────────────────────
// Prevents two bridge processes from running simultaneously (which causes every
// message to be sent twice). Writes a PID file on start; exits if another
// process already holds the lock.
if (fs.existsSync(PID_FILE)) {
  const existingPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
  try {
    process.kill(existingPid, 0); // signal 0 = just check if process exists
    console.error(`❌  Another bridge instance is already running (PID ${existingPid}). Exiting.`);
    console.error(`    To force restart: rm ${PID_FILE} and try again.`);
    process.exit(1);
  } catch {
    // Process doesn't exist — stale PID file, safe to overwrite
    console.log(`⚠️  Stale PID file found (PID ${existingPid} is gone). Starting fresh.`);
  }
}
fs.writeFileSync(PID_FILE, String(process.pid));
process.on('exit', () => { try { fs.unlinkSync(PID_FILE); } catch {} });
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT',  () => process.exit(0));

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

// ─── Per-process chat resolution cache ───────────────────────────────────────
// Maps apple chat_identifier → { dealId: string|null, isGroup: bool, participants: string[] }
// null dealId means "skip this chat" (personal or unresolvable).
// Cache survives across ticks so we only do the Supabase lookup once per chat.
const chatCache = new Map();

// ─── In-flight send guard ─────────────────────────────────────────────────────
// Tracks message IDs currently being sent via AppleScript. If the poll fires
// again before osascript returns (AppleScript can take >5s), this prevents the
// same row from being picked up and sent a second time.
const sendingInFlight = new Set();

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

/** Look up which deal a phone number belongs to via the existing Supabase RPC. */
async function findDealForPhone(phone) {
  if (!phone) return null;
  const bare = phone.replace(/^\+1/, '');
  const { data, error } = await sb.rpc('find_deal_by_phone', { phone_e164: phone, phone_bare: bare });
  if (error) { console.error('⚠️  find_deal_by_phone error:', error.message); return null; }
  return data?.[0]?.id || null;
}

// ─── Outbound: send via Messages.app AppleScript ─────────────────────────────

function sendViaMessages(toPhone, body) {
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
    if (sendingInFlight.has(msg.id)) {
      console.log(`⏭ SKIP  ${msg.to_number}  already sending (in-flight)`);
      continue;
    }
    sendingInFlight.add(msg.id);
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
    } finally {
      sendingInFlight.delete(msg.id);
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
  // Map of chatIdentifier → [phone, ...] built while DB is still open
  const participantsByChatId = new Map();

  try {
    rows = db.prepare(`
      SELECT
        m.ROWID,
        m.guid,
        m.text,
        m.date,
        m.is_from_me,
        m.associated_message_type,
        m.associated_message_guid,
        h.id              AS sender_handle,    -- who sent this specific message
        c.chat_identifier,                     -- phone for 1:1, Apple GUID for groups
        c.style           AS chat_style,       -- 43 = 1:1, 45 = group
        c.display_name    AS chat_display_name -- group name if set
      FROM message m
      LEFT JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
      LEFT JOIN chat              c   ON cmj.chat_id = c.ROWID
      LEFT JOIN handle            h   ON m.handle_id = h.ROWID
      WHERE m.ROWID > ?
        AND m.text IS NOT NULL
        AND m.text != ''
      ORDER BY m.ROWID ASC
      LIMIT 100
    `).all(watermark);

    // For group chats not yet cached, fetch participant list while DB is open.
    const unseenGroupIds = [...new Set(
      rows
        .filter(r => r.chat_style === 45 && !chatCache.has(r.chat_identifier))
        .map(r => r.chat_identifier)
        .filter(Boolean)
    )];

    for (const chatId of unseenGroupIds) {
      const parts = db.prepare(`
        SELECT DISTINCT h.id AS phone
        FROM chat_handle_join chj
        JOIN handle h ON chj.handle_id = h.ROWID
        JOIN chat   c ON chj.chat_id   = c.ROWID
        WHERE c.chat_identifier = ?
          AND h.id NOT LIKE '%@%'
      `).all(chatId);
      participantsByChatId.set(
        chatId,
        parts.map(p => normalizePhone(p.phone)).filter(Boolean)
      );
    }
  } finally {
    db.close();
  }

  if (rows.length === 0) return;

  // ── Resolve group chats not yet in cache ─────────────────────────────────
  // Must happen after DB close (async Supabase calls).
  for (const [chatId, phones] of participantsByChatId) {
    if (phones.length === 0) {
      chatCache.set(chatId, { dealId: null, isGroup: true, participants: [] });
      continue;
    }

    // Every non-Nathan participant must resolve to the SAME deal.
    let commonDeal = null;
    let allMatch   = true;
    for (const phone of phones) {
      const dealId = await findDealForPhone(phone);
      if (!dealId) { allMatch = false; break; }
      if (commonDeal === null) { commonDeal = dealId; }
      else if (commonDeal !== dealId) { allMatch = false; break; }
    }

    const resolved = allMatch && commonDeal ? commonDeal : null;
    if (!resolved) {
      console.log(`⏭ SKIP personal/unroutable group chat  id=${chatId}  phones=[${phones.join(',')}]`);
    }
    chatCache.set(chatId, { dealId: resolved, isGroup: true, participants: phones });
  }

  // ── Process each message row ──────────────────────────────────────────────
  let maxRowid = watermark;

  for (const row of rows) {
    maxRowid = Math.max(maxRowid, row.ROWID);

    const chatId    = row.chat_identifier;
    const isGroup   = row.chat_style === 45;
    const isInbound = row.is_from_me === 0;
    const guid      = `imsg_${row.guid}`;
    const reactType = REACTION_EMOJI[row.associated_message_type] || null;

    let fromPhone, toPhone, dealId, threadKey;

    if (isGroup) {
      // ── Group chat ────────────────────────────────────────────────────────
      const cached = chatCache.get(chatId);
      if (!cached || !cached.dealId) continue; // personal / unroutable

      dealId    = cached.dealId;
      fromPhone = isInbound ? (normalizePhone(row.sender_handle) || NATHAN_NUMBER) : NATHAN_NUMBER;
      toPhone   = isInbound ? NATHAN_NUMBER : null; // no single recipient for group outbound
      threadKey = `${dealId}:group:${chatId}`;

    } else {
      // ── 1:1 chat ─────────────────────────────────────────────────────────
      const contactPhone = normalizePhone(
        isInbound ? (row.sender_handle || chatId) : chatId
      );
      if (!contactPhone) continue;

      // Resolve deal — must do this explicitly since channel='imessage' bypasses trigger.
      if (chatCache.has(chatId)) {
        dealId = chatCache.get(chatId)?.dealId || null;
      } else {
        dealId = await findDealForPhone(contactPhone);
        chatCache.set(chatId, { dealId, isGroup: false, participants: [contactPhone] });
      }
      if (!dealId) continue; // unroutable number (personal 1:1)

      fromPhone = isInbound ? contactPhone : NATHAN_NUMBER;
      toPhone   = isInbound ? NATHAN_NUMBER : contactPhone;
      threadKey = `${dealId}:phone:${isInbound ? fromPhone : toPhone}`;
    }

    const msgData = {
      from_number:  fromPhone,
      to_number:    toPhone,
      body:         reactType ? `${reactType} reacted to: "${row.text.replace(/^(Liked|Loved|Disliked|Emphasized|Questioned|Laughed at) "/, '').replace(/"$/, '')}"` : row.text,
      direction:    isInbound ? 'inbound' : 'outbound',
      status:       isInbound ? 'received' : 'sent',
      channel:      'imessage',
      twilio_sid:   guid,
      created_at:   appleTs(row.date),
      deal_id:      dealId,
      thread_key:   threadKey,
    };

    // For outbound (is_from_me) messages: check if a DCC-originated row already
    // exists with the same body + to_number sent within the last 10 minutes.
    // DCC rows have no twilio_sid, so the upsert wouldn't conflict — this
    // prevents a duplicate bubble appearing for every DCC-sent iMessage.
    if (!isInbound) {
      const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const { data: existing } = await sb
        .from('messages_outbound')
        .select('id')
        .eq('to_number', msgData.to_number)
        .eq('body', msgData.body)
        .eq('direction', 'outbound')
        .is('twilio_sid', null)
        .gte('created_at', tenMinAgo)
        .limit(1);
      if (existing && existing.length > 0) {
        // Stamp the DCC row with the chat.db guid so future syncs don't re-check
        await sb.from('messages_outbound')
          .update({ twilio_sid: guid })
          .eq('id', existing[0].id);
        maxRowid = Math.max(maxRowid, row.ROWID);
        continue;  // skip inserting duplicate
      }
    }

    const { error } = await sb.from('messages_outbound').upsert(msgData, {
      onConflict: 'twilio_sid',
      ignoreDuplicates: true,
    });

    if (error) {
      console.error(`⚠️  Supabase error (${guid}):`, error.message);
    } else {
      const tag     = isGroup ? `GRP` : (isInbound ? '⬇ IN ' : '⬆ OUT');
      const preview = msgData.body.length > 60 ? msgData.body.slice(0, 57) + '…' : msgData.body;
      console.log(`${tag}  ${fromPhone || toPhone}  "${preview}"`);
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
