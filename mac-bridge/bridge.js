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
const OUR_NUMBERS    = new Set([NATHAN_NUMBER, '+15139985440']); // numbers we own — never a "contact"
const SUPABASE_URL   = 'https://rcfaashkfpurkvtmsmeb.supabase.co';
const SERVICE_KEY    = process.env.SUPABASE_SERVICE_KEY;
const CHAT_DB_PATH   = path.join(os.homedir(), 'Library/Messages/chat.db');
const WATERMARK_FILE = path.join(__dirname, '.watermark');
const POLL_MS        = 5000;
const APPLE_EPOCH    = 978307200; // Jan 1 2001 in Unix seconds

// Reaction type → emoji mapping (Apple associated_message_type values)
const REACTION_EMOJI = { 2000: '👍', 2001: '❤️', 2002: '👎', 2003: '‼️', 2004: '❓', 2005: '😂' };

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

// ─── Per-process chat resolution cache ───────────────────────────────────────
// Maps apple chat_identifier → { dealId: string|null, isGroup: bool, participants: string[], groupId: string|null }
// null dealId means "skip this chat" (personal or unresolvable).
// Cache survives across ticks so we only do the Supabase lookup once per chat.
const chatCache = new Map();

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

/** Canonical thread_key for a message.
 *  Always keys on the contact's number, never ours.
 *  Uses 'group:' prefix only when multiple non-Nathan participants are present.
 *  participants: array of phone strings (may include Nathan's numbers). */
function canonicalThreadKey(dealId, fromPhone, toPhone, participants) {
  const pool = participants && participants.length
    ? participants
    : [fromPhone, toPhone].filter(Boolean);
  const contacts = pool.filter(p => !OUR_NUMBERS.has(p));
  const kind = contacts.length > 1 ? 'group' : 'phone';
  return `${dealId}:${kind}:${contacts[0] || fromPhone || toPhone}`;
}

/** Look up which deal a phone number belongs to via the existing Supabase RPC. */
async function findDealForPhone(phone) {
  if (!phone) return null;
  const bare = phone.replace(/^\+1/, '');
  const { data, error } = await sb.rpc('find_deal_by_phone', { phone_e164: phone, phone_bare: bare });
  if (error) { console.error('⚠️  find_deal_by_phone error:', error.message); return null; }
  return data?.[0]?.id || null;
}

/** Look up or create a message_groups row for an iMessage group chat.
 *  The row is keyed by apple_chat_guid stored inside the participants jsonb array.
 *  Returns the UUID string, or null on failure. */
async function lookupOrCreateMessageGroup(chatId, dealId, phones, displayName) {
  // Find existing row by apple_chat_guid embedded in participants jsonb.
  const { data: existing, error: lookupErr } = await sb
    .from('message_groups')
    .select('id')
    .eq('deal_id', dealId)
    .contains('participants', JSON.stringify([{ apple_chat_guid: chatId }]))
    .maybeSingle();
  if (lookupErr) { console.error('⚠️  message_groups lookup error:', lookupErr.message); }
  if (existing) return existing.id;

  const label        = displayName || phones.join(' + ');
  const participants = [
    ...phones.map(p => ({ phone: p })),
    { apple_chat_guid: chatId },
  ];
  const { data: created, error: insertErr } = await sb
    .from('message_groups')
    .insert({ deal_id: dealId, label, participants, channel: 'imessage' })
    .select('id')
    .single();
  if (insertErr) { console.error('⚠️  message_groups insert error:', insertErr.message); return null; }
  console.log(`📋 GROUP  created message_groups ${created.id}  label="${label}"`);
  return created.id;
}

// ─── Outbound: send via Messages.app AppleScript ─────────────────────────────

let consecutiveOscriptTimeouts = 0; // auto-restart Messages.app after N consecutive hangs

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
    try {
      sendViaMessages(msg.to_number, msg.body);
      consecutiveOscriptTimeouts = 0;
      await sb.from('messages_outbound').update({ status: 'sent' }).eq('id', msg.id);
      const preview = msg.body.length > 60 ? msg.body.slice(0, 57) + '…' : msg.body;
      console.log(`⬆ SENT  ${msg.to_number}  "${preview}"`);
    } catch (err) {
      if (err.message.includes('ETIMEDOUT')) {
        consecutiveOscriptTimeouts++;
        console.error(`⏱ TIMEOUT ${consecutiveOscriptTimeouts}/3  ${msg.to_number}`);
        if (consecutiveOscriptTimeouts >= 3) {
          console.error('🔄 Messages.app health: 3 consecutive timeouts — force-restarting');
          try {
            execFileSync('killall', ['-9', 'Messages'], { timeout: 5000 });
          } catch (_) {}
          try {
            execFileSync('killall', ['-9', 'imagent'],  { timeout: 5000 });
          } catch (_) {}
          await new Promise(r => setTimeout(r, 4000));
          try {
            execFileSync('open', ['-a', 'Messages'], { timeout: 10000 });
            console.log('✅ Messages.app restarted');
          } catch (e) {
            console.error('⚠️  Messages.app open failed:', e.message);
          }
          consecutiveOscriptTimeouts = 0;
        }
      } else {
        consecutiveOscriptTimeouts = 0;
      }
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
  // Map of chatIdentifier → { phones: string[], displayName: string|null } built while DB is still open
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
      const displayName = rows.find(r => r.chat_identifier === chatId)?.chat_display_name || null;
      participantsByChatId.set(chatId, {
        phones: parts.map(p => normalizePhone(p.phone)).filter(Boolean),
        displayName,
      });
    }
  } finally {
    db.close();
  }

  if (rows.length === 0) return;

  // ── Resolve group chats not yet in cache ─────────────────────────────────
  // Must happen after DB close (async Supabase calls).
  for (const [chatId, { phones, displayName }] of participantsByChatId) {
    if (phones.length === 0) {
      chatCache.set(chatId, { dealId: null, isGroup: true, participants: [], groupId: null });
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
      chatCache.set(chatId, { dealId: null, isGroup: true, participants: phones, groupId: null });
      continue;
    }
    const groupId = await lookupOrCreateMessageGroup(chatId, resolved, phones, displayName);
    chatCache.set(chatId, { dealId: resolved, isGroup: true, participants: phones, groupId });
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
      threadKey = canonicalThreadKey(dealId, fromPhone, toPhone, cached.participants);

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
      threadKey = canonicalThreadKey(dealId, fromPhone, toPhone, null);
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
      group_id:     (isGroup && (chatCache.get(chatId)?.participants || []).filter(p => !OUR_NUMBERS.has(p)).length > 1)
                    ? (chatCache.get(chatId)?.groupId || null) : null,
    };

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
