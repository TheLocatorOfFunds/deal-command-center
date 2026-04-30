// lauren-event-router
//
// Fires when a row in `lauren_conversations` (the website-logged
// transcript table) is inserted or meaningfully changes. Pulls the
// row, decides whether the event is alert-worthy, dedupes against
// recent alerts, and emails Nathan at nathan@fundlocators.com.
//
// The trigger payload tells us WHICH event happened. The router does
// the actual decision-making + send.
//
// Triggered by Postgres trigger lauren_event_dispatch via
// pg_net.http_post (see migration 20260430220000_lauren_event_router.sql).
//
// Auth: shared secret in X-Lauren-Event-Secret header. Secret lives in
// vault.decrypted_secrets under name 'lauren_event_secret'.
//
// Request body: { event: 'started' | 'submitted' | 'message_added',
//                 conversation_id: uuid }
// Response: { sent: bool, reason?: string, alert_id?: uuid }

import { createClient } from "jsr:@supabase/supabase-js@2";

const NATHAN_EMAIL = "nathan@fundlocators.com";
const FROM_EMAIL = "RefundLocators Lauren <hello@refundlocators.com>";

// Keywords that flip a normal message into an alert. Lowercased
// substring match. Tune over time.
const KEYWORD_WATCHLIST = [
  "scam", "scammer", "scammed",
  "lawyer", "attorney", "lawsuit", "sue",
  "ag ", "attorney general",
  "complaint", "bbb", "better business",
  "fraud", "fraudulent",
  "report you", "report this",
  "news", "reporter", "media",
  "police",
];

// Per-visitor / per-signal-type debounce window. If we already sent
// an alert of the same type for the same visitor within this window,
// skip.
const DEDUPE_HOURS = 1;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const secret = Deno.env.get("LAUREN_EVENT_SECRET");
  if (!secret) return json({ error: "LAUREN_EVENT_SECRET not configured" }, 503);
  if (req.headers.get("X-Lauren-Event-Secret") !== secret) {
    return json({ error: "Unauthorized" }, 401);
  }

  let event: string;
  let conversation_id: string;
  try {
    const body = await req.json();
    event = String(body.event || "");
    conversation_id = String(body.conversation_id || "");
    if (!event || !conversation_id) throw new Error("event and conversation_id required");
  } catch (e) {
    return json({ error: String(e) }, 400);
  }

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // ── Pull the conversation ─────────────────────────────────────────
  const { data: conv, error: convErr } = await db
    .from("lauren_conversations")
    .select("id, visitor_id, started_at, last_message_at, page_origin, token, seed_message, transcript, message_count, submitted_claim, ip")
    .eq("id", conversation_id)
    .single();
  if (convErr || !conv) return json({ sent: false, reason: "conversation_not_found" });

  // ── Decide signal_type + whether this event is alert-worthy ───────
  let signal_type: string | null = null;
  let detail: Record<string, unknown> = {};

  if (event === "submitted") {
    // Always alert on claim submission.
    signal_type = "claim_submitted";
  } else if (event === "started") {
    // Alert on token mode (high-value: they came from a personalized
    // link), or on generic mode if 5+ messages have already been
    // exchanged (a real conversation, not a bounce).
    if (conv.token) {
      signal_type = "token_chat_started";
    } else if ((conv.message_count || 0) >= 5) {
      signal_type = "engaged_chat";
    }
  } else if (event === "message_added") {
    // Scan the transcript for keywords. Only check the most recent
    // user message — earlier ones already had a chance to fire.
    const transcript = Array.isArray(conv.transcript) ? conv.transcript : [];
    const lastUser = [...transcript].reverse().find((m: any) => m && m.role === "user");
    if (lastUser && lastUser.content) {
      const lower = String(lastUser.content).toLowerCase();
      const hit = KEYWORD_WATCHLIST.find((kw) => lower.includes(kw));
      if (hit) {
        signal_type = "keyword_hit";
        detail.keyword = hit;
        detail.user_message = String(lastUser.content).slice(0, 500);
      }
    }
  }

  if (!signal_type) {
    return json({ sent: false, reason: "not_alert_worthy" });
  }

  // ── Dedupe ───────────────────────────────────────────────────────
  const sinceIso = new Date(Date.now() - DEDUPE_HOURS * 3600_000).toISOString();
  const { data: recent } = await db
    .from("lauren_alerts")
    .select("id")
    .eq("visitor_id", conv.visitor_id)
    .eq("signal_type", signal_type)
    .gte("sent_at", sinceIso)
    .limit(1);
  if (recent && recent.length > 0) {
    return json({ sent: false, reason: "deduped" });
  }

  // ── Build the email ──────────────────────────────────────────────
  const subjectMap: Record<string, string> = {
    claim_submitted: `Lauren · claim submitted${conv.token ? ` · token ${conv.token.slice(0, 8)}` : ""}`,
    token_chat_started: `Lauren · token chat started${conv.token ? ` · ${conv.token.slice(0, 8)}` : ""}`,
    engaged_chat: `Lauren · engaged chat (${conv.message_count} msgs) · ${conv.page_origin || "/"}`,
    keyword_hit: `Lauren · keyword "${detail.keyword}" · ${conv.page_origin || "/"}`,
  };
  const subject = subjectMap[signal_type] || `Lauren · ${signal_type}`;

  const transcript = Array.isArray(conv.transcript) ? conv.transcript : [];
  const tail = transcript.slice(-6).map((m: any, i: number) => {
    const role = m.role === "user" ? "Visitor" : "Lauren";
    const content = String(m.content || "").slice(0, 600);
    return `[${role}] ${content}`;
  }).join("\n\n");

  const lines: string[] = [];
  lines.push(`Signal: ${signal_type}`);
  if (detail.keyword) lines.push(`Keyword matched: "${detail.keyword}"`);
  lines.push(`Visitor: ${conv.visitor_id}`);
  lines.push(`Page: ${conv.page_origin || "/"}`);
  if (conv.token) lines.push(`Token: ${conv.token}`);
  lines.push(`Started: ${conv.started_at}`);
  lines.push(`Last msg: ${conv.last_message_at}`);
  lines.push(`Messages: ${conv.message_count}`);
  if (conv.submitted_claim) lines.push(`Claim submitted: yes`);
  lines.push("");
  lines.push("--- Recent transcript (last 6 turns) ---");
  lines.push(tail || "(empty)");
  lines.push("");
  lines.push(`Full transcript: https://app.refundlocators.com/admin/lauren/${conv.id}`);

  const text = lines.join("\n");
  const html = `<pre style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; line-height: 1.5; white-space: pre-wrap; color: #111; background: #fff; padding: 16px; border: 1px solid #e5e7eb; border-radius: 8px;">${escapeHtml(text)}</pre>`;

  // ── Send via Resend ───────────────────────────────────────────────
  const { data: keyRow } = await db
    .from("vault.decrypted_secrets")
    .select("decrypted_secret")
    .eq("name", "resend_api_key")
    .single();
  const resendKey = keyRow?.decrypted_secret;
  if (!resendKey) return json({ sent: false, reason: "resend_api_key not in Vault" }, 503);

  const sendResp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${resendKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [NATHAN_EMAIL],
      subject,
      text,
      html,
    }),
  });

  if (!sendResp.ok) {
    const txt = await sendResp.text();
    return json({ sent: false, reason: `resend ${sendResp.status}: ${txt.slice(0, 200)}` }, 502);
  }

  // ── Record the alert (so dedupe and the future DCC sidebar can read it) ──
  const { data: alertRow } = await db
    .from("lauren_alerts")
    .insert({
      conversation_id: conv.id,
      visitor_id: conv.visitor_id,
      signal_type,
      meta: detail,
    })
    .select("id")
    .single();

  return json({ sent: true, alert_id: alertRow?.id, signal_type });
});

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
