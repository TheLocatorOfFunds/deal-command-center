import { createClient } from 'jsr:@supabase/supabase-js@2'

/**
 * drop-rvm — Personalized RVM pipeline
 *
 * Two generation modes per template (rvm_templates.generation_mode):
 *
 *   merge_fields   — mechanical {placeholder} substitution from deal/contact/meta.
 *                    Predictable, fast, cheap. For bulk cadence drops.
 *
 *   ai_personalized — regenerates the deal's case_intel_summary, then asks
 *                    Claude to write a per-case voicemail script using only
 *                    public-facing case facts (no internal operational state).
 *                    For high-priority Tier A cases.
 *
 * Both modes flow through Fish Audio TTS → Supabase Storage → (Slybroadcast
 * delivery, when API approval lands).
 *
 * Edge Function secrets:
 *   - FISH_AUDIO_API_KEY        (Fish Audio TTS)
 *   - NATHAN_VOICE_ID           (default voice)
 *   - ANTHROPIC_API_KEY         (Claude for ai_personalized mode + case intel)
 *   - SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (auto)
 *   - SLYBROADCAST_USER         (account email — e.g. justin@fundlocators.com)
 *   - SLYBROADCAST_API_PASSWORD (c_password from Slybroadcast → My Account → API access)
 *   - SLYBROADCAST_CALLER_ID    (optional — defaults to CALLBACK_PHONE / +15139985440)
 *
 * If SLYBROADCAST_USER + SLYBROADCAST_API_PASSWORD are NOT set, this function
 * still generates audio and uploads it to storage — it just skips delivery.
 * That keeps the pipeline testable while we wait for Slybroadcast API approval.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const STORAGE_BUCKET = 'rvm-audio'
const FISH_AUDIO_TTS_URL = 'https://api.fish.audio/v1/tts'
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const CLAUDE_MODEL = 'claude-sonnet-4-5'
const DEFAULT_TTS_MODEL = 's1'

// ───── Formatting helpers ───────────────────────────────────────────────────

/** Round to natural-sounding spoken value: $208,283 → "around two hundred thousand dollars" */
function naturalDollars(n: number | string | null | undefined): string {
  if (n == null || n === '') return ''
  const num = typeof n === 'number' ? n : parseFloat(String(n).replace(/[$,]/g, ''))
  if (isNaN(num) || num <= 0) return ''
  if (num >= 1_000_000) {
    const m = Math.round(num / 100_000) / 10
    return `around ${m} million dollars`
  }
  if (num >= 100_000) {
    // Round to nearest $10K and spell it: 208283 → "two hundred and ten thousand"
    const tens = Math.round(num / 10_000) * 10_000
    return `around ${spellThousands(tens)} dollars`
  }
  if (num >= 10_000) {
    const tens = Math.round(num / 1_000) * 1_000
    return `around ${spellThousands(tens)} dollars`
  }
  return `around ${Math.round(num).toLocaleString()} dollars`
}

/** 210000 → "two hundred and ten thousand"; 50000 → "fifty thousand" */
function spellThousands(n: number): string {
  const k = Math.round(n / 1_000)
  if (k === 0) return `${n}`
  if (k < 10) return `${spellNumber(k)} thousand`
  if (k < 100) {
    const tens = Math.floor(k / 10) * 10
    const ones = k % 10
    return ones === 0 ? `${spellNumber(tens)} thousand` : `${spellNumber(tens)} ${spellNumber(ones)} thousand`
  }
  if (k < 1000) {
    const hundreds = Math.floor(k / 100)
    const remainder = k % 100
    if (remainder === 0) return `${spellNumber(hundreds)} hundred thousand`
    if (remainder < 10) return `${spellNumber(hundreds)} hundred and ${spellNumber(remainder)} thousand`
    const tens = Math.floor(remainder / 10) * 10
    const ones = remainder % 10
    return ones === 0
      ? `${spellNumber(hundreds)} hundred and ${spellNumber(tens)} thousand`
      : `${spellNumber(hundreds)} hundred and ${spellNumber(tens)} ${spellNumber(ones)} thousand`
  }
  return `${k.toLocaleString()}`
}

function spellNumber(n: number): string {
  const ones: Record<number, string> = {
    0: 'zero', 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five',
    6: 'six', 7: 'seven', 8: 'eight', 9: 'nine', 10: 'ten',
    11: 'eleven', 12: 'twelve', 13: 'thirteen', 14: 'fourteen', 15: 'fifteen',
    16: 'sixteen', 17: 'seventeen', 18: 'eighteen', 19: 'nineteen',
  }
  const tens: Record<number, string> = {
    20: 'twenty', 30: 'thirty', 40: 'forty', 50: 'fifty',
    60: 'sixty', 70: 'seventy', 80: 'eighty', 90: 'ninety',
  }
  if (n in ones) return ones[n]
  if (n in tens) return tens[n]
  return `${n}`
}

/** "2026-06-04" → "June 4th" */
function naturalDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const month = d.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })
  const day = d.getUTCDate()
  const suffix = (n: number) => {
    if (n >= 11 && n <= 13) return 'th'
    const last = n % 10
    return last === 1 ? 'st' : last === 2 ? 'nd' : last === 3 ? 'rd' : 'th'
  }
  return `${month} ${day}${suffix(day)}`
}

// USPS-style street-suffix abbreviations → spelled-out words. Without this,
// TTS reads "423 Sample Rd" as "four-two-three Sample R-D". Justin caught
// this in the first AI-generated voicemail; expanding to "Road" fixes it.
const STREET_SUFFIX_MAP: Record<string, string> = {
  ALY: 'Alley', ANX: 'Annex', ARC: 'Arcade', AVE: 'Avenue', AV: 'Avenue',
  BCH: 'Beach', BLF: 'Bluff', BLVD: 'Boulevard', BLV: 'Boulevard', BR: 'Branch',
  BRG: 'Bridge', BRK: 'Brook', BYP: 'Bypass', CIR: 'Circle', CLB: 'Club',
  CMN: 'Common', COR: 'Corner', CRK: 'Creek', CRES: 'Crescent', CRS: 'Crossing',
  CSWY: 'Causeway', CT: 'Court', CTR: 'Center', CTS: 'Courts', CV: 'Cove',
  CYN: 'Canyon', DR: 'Drive', DRWY: 'Driveway', EST: 'Estate', ESTS: 'Estates',
  EXPY: 'Expressway', EXT: 'Extension', FLD: 'Field', FLDS: 'Fields',
  FRD: 'Ford', FRG: 'Forge', FRK: 'Fork', FRST: 'Forest', FT: 'Fort',
  FWY: 'Freeway', GDN: 'Garden', GDNS: 'Gardens', GLN: 'Glen', GR: 'Grove',
  GRN: 'Green', HBR: 'Harbor', HLS: 'Hills', HOLW: 'Hollow', HTS: 'Heights',
  HWY: 'Highway', IS: 'Island', ISLE: 'Isle', JCT: 'Junction', KY: 'Key',
  LK: 'Lake', LN: 'Lane', LNDG: 'Landing', LP: 'Loop', MDW: 'Meadow',
  MDWS: 'Meadows', ML: 'Mill', MLS: 'Mills', MNR: 'Manor', MT: 'Mount',
  MTN: 'Mountain', MTWY: 'Motorway', PKWY: 'Parkway', PK: 'Park', PL: 'Place',
  PLN: 'Plain', PLZ: 'Plaza', PNE: 'Pine', PT: 'Point', PRT: 'Port',
  RD: 'Road', RDG: 'Ridge', RIV: 'River', RNCH: 'Ranch', RTE: 'Route',
  SHR: 'Shore', SQ: 'Square', ST: 'Street', STA: 'Station', TER: 'Terrace',
  TPKE: 'Turnpike', TRL: 'Trail', TUNL: 'Tunnel', UN: 'Union', VLG: 'Village',
  VLY: 'Valley', VW: 'View', WL: 'Well', XING: 'Crossing',
}

const DIRECTIONAL_MAP: Record<string, string> = {
  N: 'North', S: 'South', E: 'East', W: 'West',
  NE: 'Northeast', NW: 'Northwest', SE: 'Southeast', SW: 'Southwest',
}

/** Replace street-suffix abbreviations and directional prefixes for spoken delivery.
 *  "423 Sample Rd, Oxford, OH 45056" → "423 Sample Road, Oxford, OH 45056"
 *  "456 N Main St"                   → "456 North Main Street"
 *  Only operates on the street portion (before the first comma). City/state/zip
 *  are left alone since "St. Louis" and "OH" should not be re-expanded.
 */
function expandAddressForSpeech(addr: string): string {
  if (!addr) return addr
  const parts = addr.split(',')
  let street = (parts[0] ?? '').trim()
  if (!street) return addr

  // Expand directional standalone tokens anywhere in the street.
  street = street.replace(/\b([NSEW]|NE|NW|SE|SW)\b\.?/g, (m, abbrev) => {
    const u = abbrev.toUpperCase()
    return DIRECTIONAL_MAP[u] ?? m
  })

  // Expand street suffix at the end of the street portion (or before unit
  // designators). Common pattern: "...Rd" or "...Rd Apt 5" or "...Rd #3".
  // We catch the LAST cap-token before optional unit/end.
  street = street.replace(
    /\b([A-Za-z]{2,5})\.?\b(\s*(?:Apt|Apartment|Unit|Suite|Ste|#|No)?[^,]*)?$/i,
    (full, abbrev, tail) => {
      const u = abbrev.toUpperCase()
      const expanded = STREET_SUFFIX_MAP[u]
      if (!expanded) return full
      return `${expanded}${tail || ''}`
    },
  )

  parts[0] = street
  return parts.join(',')
}

/** "423 Sample Rd, Oxford, OH 45056" → { street, city, state_zip } with abbreviations expanded for TTS */
function parseAddress(addr: string | null | undefined) {
  if (!addr) return { street: '', city: '', stateZip: '', full: '' }
  const expanded = expandAddressForSpeech(addr)
  const parts = expanded.split(',').map(s => s.trim())
  return {
    street: parts[0] || '',
    city: parts[1] || '',
    stateZip: parts.slice(2).join(', ') || '',
    full: expanded.trim(),
  }
}

function pickFirstName(name: string | null | undefined): string {
  if (!name) return ''
  return name.trim().split(/\s+/)[0] || ''
}
function pickLastName(name: string | null | undefined): string {
  if (!name) return ''
  const parts = name.trim().split(/\s+/)
  return parts.length > 1 ? parts.slice(1).join(' ') : ''
}

function normalizePhone(raw: string): string {
  const digits = (raw || '').replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return raw
}

// ───── Callback phone (the Twilio number we want recipients to call back) ───
// Hardcoded to the FundLocators Main Twilio number per Justin 2026-05-05.
// If we ever rotate the callback number, override via CALLBACK_PHONE env var.
const DEFAULT_CALLBACK_PHONE = '+15139985440'

/** "5139985440" → "five one three, nine nine eight, five four four oh"
 *  Spelled-out form is the safest for TTS — bypasses any model-specific
 *  digit-grouping quirks (some TTS read 5440 as "fifty-four forty"). */
function naturalPhone(raw: string | null | undefined): string {
  if (!raw) return ''
  const digits = String(raw).replace(/\D/g, '')
  const local = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits
  if (local.length !== 10) return raw // not standard US, return as-is
  const spell = (d: string) => d === '0' ? 'oh' : ['zero','one','two','three','four','five','six','seven','eight','nine'][parseInt(d, 10)]
  const area = Array.from(local.slice(0, 3)).map(spell).join(' ')
  const exch = Array.from(local.slice(3, 6)).map(spell).join(' ')
  const sub = Array.from(local.slice(6, 10)).map(spell).join(' ')
  return `${area}, ${exch}, ${sub}`
}

/** "+15139985440" → "513-998-5440" — display form for the merge field */
function displayPhone(raw: string | null | undefined): string {
  if (!raw) return ''
  const digits = String(raw).replace(/\D/g, '')
  const local = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits
  if (local.length !== 10) return raw
  return `${local.slice(0, 3)}-${local.slice(3, 6)}-${local.slice(6, 10)}`
}

// ───── Strategy A: Merge field rendering ─────────────────────────────────────
// Sensible fallbacks so missing fields don't render as literal "{first_name}"
const FALLBACKS: Record<string, string> = {
  first_name: 'there',
  full_name: 'there',
  county: 'your county',
  case_number: 'your case',
  property_address: 'your property',
  property_street: 'your property',
  estimated_surplus: 'the surplus we found',
  surplus_natural: 'a significant surplus',
  judgment_amount: 'the judgment amount',
  sale_date: 'your sale date',
  sale_natural_date: 'your sale date',
  post_auction_phrase: 'about your property',
  callback_phone: '513-998-5440',
  callback_phone_natural: 'five one three, nine nine eight, five four four oh',
}

function renderTemplate(text: string, vars: Record<string, string | null | undefined>): string {
  return text.replace(/\{(\w+)\}/g, (_match, key) => {
    const v = vars[key]
    if (v && String(v).trim()) return String(v).trim()
    return FALLBACKS[key] ?? `{${key}}`
  })
}

function buildMergeVars(deal: any, contact: any, overrideFirstName: string | undefined): Record<string, string> {
  const meta = (deal?.meta ?? {}) as Record<string, any>
  const homeownerName = contact?.name || meta.homeownerName || ''
  const firstName = overrideFirstName || pickFirstName(homeownerName) || ''
  const lastName = pickLastName(homeownerName)
  const addr = parseAddress(deal?.address)
  const surplus = meta.estimatedSurplus || deal?.surplus_estimate || meta.surplus_estimate || meta.verifiedSurplus || null
  const judgment = meta.judgmentAmount || meta.totalDebt || null
  const isPostAuction = meta.isPostAuction === true || meta.isPostAuction === 'true'
  const saleDateNat = naturalDate(meta.saleDate)

  // Branching helper — single phrase that hides the pre/post sale conditional
  // from the script writer.
  let postAuctionPhrase = ''
  if (isPostAuction) {
    postAuctionPhrase = saleDateNat
      ? `your property went to sale on ${saleDateNat}`
      : `your property recently went to sale`
  } else {
    postAuctionPhrase = saleDateNat
      ? `your sale coming up ${saleDateNat}`
      : `your case`
  }

  return {
    first_name: firstName,
    last_name: lastName,
    full_name: homeownerName,
    property_address: addr.full,
    property_street: addr.street,
    property_city: addr.city,
    county: meta.county || '',
    state: meta.state || '',
    case_number: (meta.courtCase || meta.caseNumber || '').trim(),
    estimated_surplus: surplus ? `$${Number(surplus).toLocaleString()}` : '',
    surplus_natural: naturalDollars(surplus),
    judgment_amount: judgment ? `$${Number(judgment).toLocaleString()}` : '',
    judgment_natural: naturalDollars(judgment),
    sale_date: meta.saleDate || '',
    sale_natural_date: saleDateNat,
    days_to_sale: deal?.days_to_sale != null ? String(deal.days_to_sale) : '',
    post_auction_phrase: postAuctionPhrase,
    is_post_auction: isPostAuction ? 'yes' : 'no',
    callback_phone: displayPhone(callbackPhone()),
    callback_phone_natural: naturalPhone(callbackPhone()),
  }
}

function callbackPhone(): string {
  return Deno.env.get('CALLBACK_PHONE') || DEFAULT_CALLBACK_PHONE
}

// ───── Strategy B: AI-personalized script via Claude ─────────────────────────

const AI_SCRIPT_SYSTEM_PROMPT = `You write personalized voicemail scripts that Nathan from RefundLocators will leave for homeowners with surplus funds tied to foreclosure.

ABSOLUTE RULES — failure to follow these is a critical error:
- ONLY use facts about THE CASE: property, foreclosure, sale, surplus amount, judgment, plaintiff, court case number, county.
- NEVER reference our internal state. Forbidden: anything about whether the homeowner has been contacted, whether they replied, whether outreach has happened, whether files are uploaded, whether internal action items exist, fee structures (25%, $13K gross, $X net), tier ratings (Tier A/B/C), agent names other than Nathan, Justin, internal notes, expense line items, the words "tier" / "imported" / "contacted yet" / "outreach" / "deal" / "lead".
- NEVER mention dollar figures with cent precision. Always round: "$208,283" → "around two hundred thousand dollars" or "over two hundred thousand". Use natural spoken numbers, not digits.
- NEVER include filler, greeting beyond "Hey {first_name}", or bullet lists. This is spoken audio.
- NEVER quote the case number with verbal punctuation. If you must say it, say it once cleanly.

STRUCTURE (60 words MAX, ~25 seconds spoken):
1. Greeting with first name + identify as Nathan from RefundLocators (5 sec)
2. ONE specific case fact that proves we know their situation (10 sec) — typically property location + sale date OR surplus amount
3. ONE concrete value statement (5 sec) — the surplus we identified
4. Soft CTA (5 sec) — end with the callback phone number, spoken digit-by-digit (the user will pass you the spoken form, e.g. "five one three, nine nine eight, five four four oh"). Use that exact spoken phrasing — DO NOT format the phone number with hyphens or as a single number string. The TTS engine reads digits ambiguously, so we always say each one out loud.

TONE: warm, calm, low-pressure. NOT a sales pitch. Like a friend who's done the work and is sharing news.

ADDRESS HANDLING: when you say the property's street, use the spoken form provided in the facts (e.g. "Sample Road"). NEVER say abbreviations like "Rd" or "St" — those will be read literally as letter sounds.

Output ONLY the spoken script. No preamble, no markdown, no labels. Just what Nathan would say into the voicemail.`

async function generateAiScript(args: {
  anthropicKey: string
  caseIntelText: string
  facts: Record<string, string>
  toneGuidance: string
  customNote?: string                                 // per-drop hint from the user, e.g. "mention the upcoming court date"
  thumbsUpExamples?: string[]                         // recent scripts the user 👍'd — train on what they like
  thumbsDownExamples?: { script: string, note?: string }[]  // recent scripts the user 👎'd, with reasons
}): Promise<string> {
  // Build feedback context. Cap counts to keep prompt tight (~400 tokens overhead).
  const upBlock = (args.thumbsUpExamples?.length ?? 0) > 0
    ? `\nEXAMPLES THE USER LIKED (write in this style — match the voice and structure):\n${args.thumbsUpExamples!.slice(0, 3).map((s, i) => `${i + 1}. "${s.replace(/"/g, '\\"')}"`).join('\n')}\n`
    : ''
  const downBlock = (args.thumbsDownExamples?.length ?? 0) > 0
    ? `\nPATTERNS TO AVOID (the user disliked these — read the reasons carefully):\n${args.thumbsDownExamples!.slice(0, 2).map((d, i) => {
        const reason = d.note ? ` — Reason: ${d.note}` : ''
        return `${i + 1}. "${d.script.replace(/"/g, '\\"')}"${reason}`
      }).join('\n')}\n`
    : ''
  const customNoteBlock = args.customNote && args.customNote.trim()
    ? `\nUSER'S SPECIFIC INSTRUCTION FOR THIS DROP (treat as authoritative, work it into the script naturally):\n"${args.customNote.trim().replace(/"/g, '\\"')}"\n`
    : ''

  const userMsg = `CASE FACTS YOU MAY USE (only these, plus what's in the intel summary that passes the rules):

- First name: ${args.facts.first_name || '(unknown)'}
- Property street (already TTS-friendly, suffixes expanded — use as-is): ${args.facts.property_street || args.facts.property_address || '(unknown)'}
- County: ${args.facts.county ? `${args.facts.county} County` : '(unknown county)'}
- Estimated surplus: ${args.facts.surplus_natural || '(unknown)'}
- Sale state: ${args.facts.is_post_auction === 'yes' ? `already sold ${args.facts.sale_natural_date || 'recently'}` : (args.facts.sale_natural_date ? `sale scheduled ${args.facts.sale_natural_date}` : 'no sale date set')}
- Judgment amount: ${args.facts.judgment_natural || '(unknown)'}
- Callback phone (use this EXACT spoken form in the CTA, do not reformat): "${args.facts.callback_phone_natural || naturalPhone(callbackPhone())}"

CASE INTEL SUMMARY (filter heavily — extract case-only facts, ignore internal operational state):
${args.caseIntelText || '(no intel summary available — work with the structured facts above)'}

TONE / STRUCTURE GUIDANCE FROM THIS TEMPLATE:
${args.toneGuidance || 'Default warm, brief, specific.'}
${customNoteBlock}${upBlock}${downBlock}
Write the voicemail script Nathan will speak. End with the spoken callback phone number from the facts above.`

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': args.anthropicKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 400,
      system: AI_SCRIPT_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMsg }],
    }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Claude script generation failed (${res.status}): ${text}`)
  }
  const json = await res.json()
  const text = (json.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('').trim()
  if (!text) throw new Error('Claude returned empty script')
  return text
}

async function loadFeedbackForTraining(sb: ReturnType<typeof createClient>) {
  // Pull last 3 thumbs-up + last 2 thumbs-down with notes for few-shot context.
  const [{ data: ups }, { data: downs }] = await Promise.all([
    sb.from('rvm_ai_feedback').select('rendered_script')
      .eq('rating', 'up').order('rated_at', { ascending: false }).limit(3),
    sb.from('rvm_ai_feedback').select('rendered_script, feedback_note')
      .eq('rating', 'down').not('feedback_note', 'is', null)
      .order('rated_at', { ascending: false }).limit(2),
  ])
  return {
    thumbsUp: (ups || []).map((r: any) => r.rendered_script as string).filter(Boolean),
    thumbsDown: (downs || []).map((r: any) => ({ script: r.rendered_script as string, note: r.feedback_note as string })).filter(d => d.script),
  }
}

async function refreshCaseIntel(args: {
  supabaseUrl: string
  serviceRoleKey: string
  authToken: string
  dealId: string
}): Promise<string | null> {
  // Trigger generate-case-summary, which writes to deals.meta.case_intel_summary
  try {
    const res = await fetch(`${args.supabaseUrl}/functions/v1/generate-case-summary`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${args.authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ deal_id: args.dealId }),
    })
    if (!res.ok) {
      console.warn(`generate-case-summary returned ${res.status}, continuing with whatever's cached`)
      return null
    }
    const json = await res.json()
    return json.text ?? null
  } catch (e) {
    console.warn('case intel refresh failed, continuing with cached:', (e as Error).message)
    return null
  }
}

// ───── Fish Audio TTS ────────────────────────────────────────────────────────
async function generateAudio(args: {
  apiKey: string
  text: string
  voiceId: string
  model?: string
}): Promise<Uint8Array> {
  const res = await fetch(FISH_AUDIO_TTS_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${args.apiKey}`,
      'Content-Type': 'application/json',
      'model': args.model ?? DEFAULT_TTS_MODEL,
    },
    body: JSON.stringify({
      text: args.text,
      reference_id: args.voiceId,
      format: 'mp3',
      mp3_bitrate: 128,
      normalize: true,
      latency: 'normal',
    }),
  })
  if (!res.ok) {
    let detail: unknown
    try { detail = await res.json() } catch { detail = await res.text() }
    throw new Error(`Fish Audio TTS failed (${res.status}): ${JSON.stringify(detail)}`)
  }
  const buf = new Uint8Array(await res.arrayBuffer())
  if (buf.byteLength < 1024) {
    const text = new TextDecoder().decode(buf)
    throw new Error(`Fish Audio returned ${buf.byteLength} bytes, likely an error: ${text}`)
  }
  return buf
}

// ───── Storage upload ────────────────────────────────────────────────────────
async function uploadAudio(args: {
  sb: ReturnType<typeof createClient>
  audio: Uint8Array
  dealId: string | null
  templateId: string | null
}): Promise<{ path: string; publicUrl: string }> {
  const ts = Date.now()
  const folder = args.dealId ?? 'manual'
  const filename = `${args.templateId ?? 'adhoc'}-${ts}.mp3`
  const path = `${folder}/${filename}`

  const { error: uploadErr } = await args.sb.storage
    .from(STORAGE_BUCKET)
    .upload(path, args.audio, {
      contentType: 'audio/mpeg',
      cacheControl: '3600',
      upsert: false,
    })
  if (uploadErr) throw new Error(`Storage upload failed: ${uploadErr.message}`)

  const { data: urlData } = args.sb.storage.from(STORAGE_BUCKET).getPublicUrl(path)
  return { path, publicUrl: urlData.publicUrl }
}

// ───── Slybroadcast delivery ─────────────────────────────────────────────────
//
// Slybroadcast API spec (https://www.slybroadcast.com/api):
//   POST https://www.mobile-sphere.com/gateway/vmb.php
//   Content-Type: application/x-www-form-urlencoded
//
//   Required params:
//     c_uid       — account email (login)
//     c_password  — API password (NOT the login password — generated under
//                   "API access" in My Account)
//     c_phone     — comma-separated E.164 or 10-digit US phone numbers (mobile only)
//     c_url       — public URL to .mp3 (or .wav) audio file
//     c_callerID  — caller ID phone number to display on the recipient's phone
//     c_date      — 'now' for immediate delivery, or YYYY-MM-DD HH:MM:SS
//     c_audio     — 'mp3' (we always send mp3)
//
//   Optional:
//     mobile_only — '1' to skip landlines (recommended — landlines bounce)
//     c_record_audio — '1' if uploading raw recording (we don't, we pass URL)
//
// Response is plain text, not JSON. Two formats:
//   "OK\nsession_id"     on success (one session covers all numbers in batch)
//   "ERROR\nerror text"  on failure
//
// Pricing (PAYG): ~$0.04-0.10/drop depending on plan tier.

const SLYBROADCAST_URL = 'https://www.mobile-sphere.com/gateway/vmb.php'

interface SlybroadcastResult {
  ok: boolean
  sessionId?: string
  error?: string
  rawResponse: string
}

/** Build the public callback URL Slybroadcast hits with delivery outcomes.
 *  Returns undefined when SLYBROADCAST_CALLBACK_SECRET isn't configured —
 *  in that case we still drop, just without delivery confirmation. */
function buildDispoUrl(supabaseUrl: string): string | undefined {
  const secret = Deno.env.get('SLYBROADCAST_CALLBACK_SECRET')
  if (!secret) return undefined
  return `${supabaseUrl}/functions/v1/slybroadcast-callback?secret=${encodeURIComponent(secret)}`
}

async function slybroadcastDrop(args: {
  user: string
  password: string
  phoneE164: string
  audioUrl: string
  callerId: string
  dispoUrl?: string  // optional Slybroadcast delivery callback URL
}): Promise<SlybroadcastResult> {
  // Slybroadcast accepts US numbers as 10-digit or with +1 prefix; normalize to
  // 10-digit form to match the format their docs show in examples.
  const phoneDigits = args.phoneE164.replace(/\D/g, '')
  const phone10 = phoneDigits.length === 11 && phoneDigits.startsWith('1')
    ? phoneDigits.slice(1)
    : phoneDigits
  const callerDigits = args.callerId.replace(/\D/g, '')
  const caller10 = callerDigits.length === 11 && callerDigits.startsWith('1')
    ? callerDigits.slice(1)
    : callerDigits

  const form = new URLSearchParams()
  form.set('c_uid', args.user)
  form.set('c_password', args.password)
  form.set('c_phone', phone10)
  form.set('c_url', args.audioUrl)
  form.set('c_callerID', caller10)
  form.set('c_date', 'now')
  form.set('c_audio', 'mp3')
  form.set('mobile_only', '1')
  // c_dispo_url — Slybroadcast hits this URL with the actual delivery
  // outcome (delivered / unable_to_detect_voicemail / etc.) once the call
  // attempt completes. Without this, the 200 response from the initial
  // POST just means "Slybroadcast accepted the request" — not "voicemail
  // was actually deposited." Per Justin 2026-05-07 ("we always want
  // confirmation and feedback on any action"), this is mandatory wiring
  // for any provider that supports delivery callbacks.
  if (args.dispoUrl) form.set('c_dispo_url', args.dispoUrl)

  const res = await fetch(SLYBROADCAST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  })

  const raw = (await res.text()).trim()

  // Slybroadcast returns 200 even for ERROR responses — we have to parse the body.
  // Format: "OK\nsession_id" or "ERROR\nmessage". Some endpoints also use
  // "OK<TAB>session_id" or single-line "OK session_id" — be liberal in parsing.
  const firstLine = raw.split(/\r?\n/)[0].trim()
  const rest = raw.slice(firstLine.length).trim()

  if (/^OK\b/i.test(firstLine)) {
    // Session id may be on the first line after "OK " or on the next line
    const inlineId = firstLine.replace(/^OK\s*/i, '').trim()
    const sessionId = inlineId || rest || undefined
    return { ok: true, sessionId, rawResponse: raw }
  }
  return { ok: false, error: rest || raw, rawResponse: raw }
}

// ───── Main handler ──────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const fishAudioKey = Deno.env.get('FISH_AUDIO_API_KEY')
  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY')
  const defaultVoiceId = Deno.env.get('NATHAN_VOICE_ID')

  if (!fishAudioKey) {
    return new Response(JSON.stringify({ error: 'FISH_AUDIO_API_KEY not configured' }), {
      status: 503,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing authorization' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    const authToken = authHeader.replace('Bearer ', '')
    let userId: string
    try {
      const b64 = authToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
      const payload = JSON.parse(atob(b64))
      userId = payload.sub
      if (!userId) throw new Error('no sub')
    } catch {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const sb = createClient(supabaseUrl, serviceRoleKey)
    const body = await req.json()
    const {
      template_id,
      deal_id,
      contact_id,
      override_text,
      override_first_name,
      to_number,
      dry_run = false,
      custom_note,  // optional per-drop hint for AI mode (e.g. "mention the upcoming court date")
      existing_message_id,  // when set, skip generation — just drop the audio referenced by this row
    } = body

    // ─── Drop-only mode (skip generation, deliver an already-generated audio) ─
    //
    // When the UI uses the two-step flow (Generate → preview → Drop), the second
    // call passes the message_id from the first call's response. We look up the
    // row, validate it's a valid RVM with audio, and POST it to Slybroadcast.
    // No TTS, no Storage upload, no new messages_outbound row — we update the
    // existing row in place.
    if (existing_message_id) {
      const slyUser = Deno.env.get('SLYBROADCAST_USER')
      const slyPassword = Deno.env.get('SLYBROADCAST_API_PASSWORD')
      const slyCallerId = Deno.env.get('SLYBROADCAST_CALLER_ID') || callbackPhone()
      if (!slyUser || !slyPassword) {
        return new Response(JSON.stringify({ error: 'Slybroadcast secrets not configured (SLYBROADCAST_USER + SLYBROADCAST_API_PASSWORD)' }), {
          status: 503,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      const { data: existingRow, error: lookupErr } = await sb
        .from('messages_outbound')
        .select('id, channel, status, to_number, media_url, body, deal_id, contact_id')
        .eq('id', existing_message_id)
        .maybeSingle()
      if (lookupErr || !existingRow) {
        return new Response(JSON.stringify({ error: `Message not found: ${existing_message_id}` }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }
      if (existingRow.channel !== 'rvm') {
        return new Response(JSON.stringify({ error: 'Message is not an RVM (channel != rvm)' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }
      if (!existingRow.media_url || !existingRow.to_number) {
        return new Response(JSON.stringify({ error: 'Message is missing media_url or to_number — cannot drop' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }
      if (existingRow.status === 'rvm_sent') {
        return new Response(JSON.stringify({ error: 'Message has already been dropped (status=rvm_sent). Generate a new one if you want to send again.' }), {
          status: 409,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      let dropResult: SlybroadcastResult | null = null
      let dropError: string | null = null
      let outboundStatus: string
      try {
        dropResult = await slybroadcastDrop({
          user: slyUser,
          password: slyPassword,
          phoneE164: existingRow.to_number,
          audioUrl: existingRow.media_url,
          callerId: slyCallerId,
          dispoUrl: buildDispoUrl(supabaseUrl),
        })
        outboundStatus = dropResult.ok ? 'rvm_sent' : 'rvm_failed'
        if (!dropResult.ok) dropError = dropResult.error ?? 'Slybroadcast rejected the drop'
      } catch (e) {
        dropError = (e as Error).message
        outboundStatus = 'rvm_failed'
      }

      const { error: updateErr } = await sb
        .from('messages_outbound')
        .update({
          status: outboundStatus,
          from_number: slyCallerId,
          provider_sid: dropResult?.sessionId ?? null,
          error_message: dropError,
        })
        .eq('id', existing_message_id)
      if (updateErr) console.error('messages_outbound update failed:', updateErr.message)

      return new Response(JSON.stringify({
        ok: outboundStatus === 'rvm_sent',
        message_id: existing_message_id,
        delivery_status: outboundStatus,
        delivery_attempted: true,
        delivery_session_id: dropResult?.sessionId ?? null,
        delivery_error: dropError,
        delivery_raw: dropResult?.rawResponse ?? null,
        to_number: existingRow.to_number,
        from_number: slyCallerId,
        mp3_url: existingRow.media_url,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    // ─── Resolve template ─────────────────────────────────────────────────
    let template: any = null
    let voiceId: string

    if (template_id) {
      const { data: tpl, error: tplErr } = await sb
        .from('rvm_templates')
        .select('*')
        .eq('id', template_id)
        .maybeSingle()
      if (tplErr || !tpl) {
        return new Response(JSON.stringify({ error: `Template not found: ${template_id}` }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }
      if (!tpl.active) {
        return new Response(JSON.stringify({ error: `Template is inactive: ${template_id}` }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }
      template = tpl
      voiceId = tpl.voice_id || defaultVoiceId || ''
    } else {
      if (!override_text) {
        return new Response(JSON.stringify({ error: 'Either template_id or override_text required' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }
      voiceId = defaultVoiceId || ''
    }

    if (!voiceId) {
      return new Response(JSON.stringify({ error: 'No voice_id available' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ─── Resolve recipient details ────────────────────────────────────────
    let deal: any = null
    let contact: any = null
    if (deal_id) {
      const { data } = await sb.from('deals').select('*').eq('id', deal_id).maybeSingle()
      deal = data
    }
    if (contact_id) {
      const { data } = await sb.from('contacts').select('*').eq('id', contact_id).maybeSingle()
      contact = data
    }

    const meta = (deal?.meta ?? {}) as Record<string, any>
    const phone = to_number
      ?? contact?.phone
      ?? meta.homeownerPhone
      ?? null
    const phoneE164 = phone ? normalizePhone(phone) : null

    const mergeVars = buildMergeVars(deal, contact, override_first_name)

    // ─── Generate script: merge_fields vs ai_personalized ─────────────────
    let renderedScript: string
    let generationMode = template?.generation_mode || 'merge_fields'
    let caseIntelUsed: string | null = null
    let aiScriptRaw: string | null = null

    if (override_text) {
      // Manual override always uses merge fields on the override text
      renderedScript = renderTemplate(override_text, mergeVars)
      generationMode = 'merge_fields' // override locks behavior
    } else if (generationMode === 'ai_personalized') {
      if (!anthropicKey) {
        return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured (required for ai_personalized templates)' }), {
          status: 503,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }
      if (!deal_id) {
        return new Response(JSON.stringify({ error: 'ai_personalized templates require deal_id' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      // Refresh case intelligence + load feedback signal in parallel
      const [freshIntel, feedback] = await Promise.all([
        refreshCaseIntel({ supabaseUrl, serviceRoleKey, authToken, dealId: deal_id }),
        loadFeedbackForTraining(sb),
      ])

      // Re-fetch deal to pick up any meta updates from the intel refresh
      const { data: refreshedDeal } = await sb.from('deals').select('*').eq('id', deal_id).maybeSingle()
      const refreshedMeta = (refreshedDeal?.meta ?? {}) as Record<string, any>
      caseIntelUsed = freshIntel ?? refreshedMeta.case_intel_summary?.text ?? meta.case_intel_summary?.text ?? null

      aiScriptRaw = await generateAiScript({
        anthropicKey,
        caseIntelText: caseIntelUsed || '',
        facts: mergeVars,
        toneGuidance: template.script || template.ai_prompt || '',
        customNote: custom_note,
        thumbsUpExamples: feedback.thumbsUp,
        thumbsDownExamples: feedback.thumbsDown,
      })
      // Even AI output gets a final merge-field pass — Claude is supposed to
      // emit clean text but if it accidentally leaves a {first_name} in there
      // (or we want to inject one explicitly), this catches it.
      renderedScript = renderTemplate(aiScriptRaw, mergeVars)
    } else {
      // merge_fields mode — straight substitution
      renderedScript = renderTemplate(template.script, mergeVars)
    }

    // ─── Generate audio via Fish Audio ────────────────────────────────────
    const audio = await generateAudio({
      apiKey: fishAudioKey,
      text: renderedScript,
      voiceId,
      model: 's1',
    })

    // ─── Upload to Supabase Storage ───────────────────────────────────────
    const { path, publicUrl } = await uploadAudio({
      sb,
      audio,
      dealId: deal_id ?? null,
      templateId: template_id ?? null,
    })

    // ─── Slybroadcast delivery (when configured + not dry run) ────────────
    const slyUser = Deno.env.get('SLYBROADCAST_USER')
    const slyPassword = Deno.env.get('SLYBROADCAST_API_PASSWORD')
    const slyCallerId = Deno.env.get('SLYBROADCAST_CALLER_ID') || callbackPhone()
    const slyConfigured = !!(slyUser && slyPassword)

    let dropResult: SlybroadcastResult | null = null
    let dropAttempted = false
    let dropError: string | null = null
    let outboundStatus: string

    if (dry_run) {
      outboundStatus = 'dry_run'
    } else if (!phoneE164) {
      outboundStatus = 'no_phone'
    } else if (!slyConfigured) {
      // Audio is generated and stored, but we can't deliver yet — Slybroadcast
      // creds are not set. This is the expected state until API approval lands.
      outboundStatus = 'audio_generated'
    } else {
      dropAttempted = true
      try {
        dropResult = await slybroadcastDrop({
          user: slyUser!,
          password: slyPassword!,
          phoneE164,
          audioUrl: publicUrl,
          callerId: slyCallerId,
          dispoUrl: buildDispoUrl(supabaseUrl),
        })
        outboundStatus = dropResult.ok ? 'rvm_sent' : 'rvm_failed'
        if (!dropResult.ok) dropError = dropResult.error ?? 'Slybroadcast rejected the drop'
      } catch (e) {
        dropError = (e as Error).message
        outboundStatus = 'rvm_failed'
      }
    }

    // ─── Insert messages_outbound record ──────────────────────────────────
    const { data: msgRow, error: msgErr } = await sb
      .from('messages_outbound')
      .insert({
        to_number:   phoneE164,
        from_number: slyConfigured ? slyCallerId : null,
        body:        renderedScript,
        status:      outboundStatus,
        sent_by:     userId,
        deal_id:     deal_id ?? null,
        contact_id:  contact_id ?? null,
        channel:     'rvm',
        direction:   'outbound',
        media_url:   publicUrl,
        provider_sid: dropResult?.sessionId ?? null,
        error_message: dropError,
      })
      .select()
      .single()

    if (msgErr) {
      console.error('messages_outbound insert failed:', msgErr.message)
    }

    return new Response(JSON.stringify({
      ok: true,
      message_id: msgRow?.id ?? null,
      mp3_url: publicUrl,
      mp3_path: path,
      rendered_script: renderedScript,
      generation_mode: generationMode,
      ai_script_raw: aiScriptRaw,        // for debugging / preview
      case_intel_used: !!caseIntelUsed,  // boolean — was intel pulled?
      custom_note_used: custom_note ?? null,  // for the feedback save flow
      to_number: phoneE164,
      voice_id: voiceId,
      template_id: template_id ?? null,
      dry_run,
      // Delivery details
      delivery_status: outboundStatus,           // dry_run | no_phone | audio_generated | rvm_sent | rvm_failed
      delivery_attempted: dropAttempted,
      delivery_session_id: dropResult?.sessionId ?? null,
      delivery_error: dropError,
      delivery_raw: dropResult?.rawResponse ?? null,  // for debugging Slybroadcast quirks
      slybroadcast_configured: slyConfigured,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  } catch (err) {
    console.error('drop-rvm error:', err)
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
