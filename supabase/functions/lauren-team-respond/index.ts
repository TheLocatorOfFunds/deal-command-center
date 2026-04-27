import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Lauren's response engine for Team Chat. Triggered by a pg trigger on
// team_messages INSERT (see migration 20260427020000) when:
//   - thread.lauren_enabled = true
//   - sender_kind != 'lauren' (no self-replies)
//   - body matches the Lauren mention regex
// Pulls last 15 messages of context, calls Claude with Lauren's system
// prompt + DCC tool descriptions, posts the response back to the thread.
//
// Tools Lauren can call (read-only, defined in the Phase 2 migration):
//   - lauren_lookup_deal(needle)
//   - lauren_recent_activity(deal_id, limit)
//   - lauren_upcoming_events(window_days)
//   - lauren_search_contacts(needle)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-5";
const MAX_TOKENS = 1024;

const SYSTEM_PROMPT = `You are Lauren, an AI teammate for Nathan and Justin at RefundLocators / FundLocators. You're in their internal team chat. Be concise, direct, and operational. Match the tone of a sharp ops manager — no fluff, no "I'd be happy to", no excess pleasantries. Plain text only (no markdown headers, no emoji unless the user used one first).

Context you should remember:
- RefundLocators recovers surplus funds for foreclosure victims (mostly Ohio cases).
- Nathan also does fix/flip + wholesale real estate deals.
- Casey Jennings is the current active deal (wholesale, 7260 Jerry Drive, West Chester, OH; $200k contract, $225k asking).
- Kevin Daubenmire is a JV partner taking 25% of Casey Jennings to manage photos, buyer, title, close.

Tools available (call by name; the runtime will execute and return results):
- lookup_deal(needle): fuzzy match a deal by name/address/id. Returns up to 5.
- recent_activity(deal_id, limit=10): timeline of recent activity for a deal.
- upcoming_events(window_days=14): court hearings + sheriff sales coming up.
- search_contacts(needle): partner attorneys, title companies, etc.

Behavior:
- If the user asks a factual question about a deal/contact/event, call the right tool first, then answer.
- If you don't know something and can't look it up, say so plainly.
- Keep replies short — chat-length, not essay-length. 1-3 short paragraphs max unless asked for detail.
- You can't write to the database, send SMS/email, or take actions. If asked to do something, tell Nathan or Justin what you'd do and let them confirm/execute.`;

const TOOLS = [
  {
    name: "lookup_deal",
    description: "Fuzzy-match a deal by name, address, or id. Returns up to 5 matches.",
    input_schema: { type: "object", properties: { needle: { type: "string" } }, required: ["needle"] },
  },
  {
    name: "recent_activity",
    description: "Recent activity timeline for a specific deal.",
    input_schema: { type: "object", properties: { deal_id: { type: "string" }, limit: { type: "integer", default: 10 } }, required: ["deal_id"] },
  },
  {
    name: "upcoming_events",
    description: "Upcoming court hearings, deadlines, and sheriff sales across all deals.",
    input_schema: { type: "object", properties: { window_days: { type: "integer", default: 14 } } },
  },
  {
    name: "search_contacts",
    description: "Find contacts (partner attorneys, title companies, etc.) by name, company, or kind.",
    input_schema: { type: "object", properties: { needle: { type: "string" } }, required: ["needle"] },
  },
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ error: "bad JSON" }, 400); }
  const { thread_id, message_id } = body;
  if (!thread_id) return json({ error: "thread_id required" }, 400);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "ANTHROPIC_API_KEY not configured" }, 500);

  const db = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));

  // Fetch last 15 messages of the thread (oldest first for proper conversation order)
  const { data: history } = await db
    .from("team_messages")
    .select("id, sender_id, sender_kind, body, attachments, created_at")
    .eq("thread_id", thread_id)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(15);
  const messages = (history || []).reverse();

  // Hydrate sender names for context
  const senderIds = [...new Set(messages.filter(m => m.sender_id).map(m => m.sender_id))];
  let senderNames = {};
  if (senderIds.length) {
    const { data: profs } = await db.from("profiles").select("id, display_name, name").in("id", senderIds);
    (profs || []).forEach(p => { senderNames[p.id] = p.display_name || p.name || "Team"; });
  }

  // Build Claude conversation. Each thread message becomes a user turn —
  // we compress the whole history into a single "here's the conversation"
  // user message so Lauren has the full context, then she replies once.
  const transcript = messages.map(m => {
    const who = m.sender_kind === "lauren" ? "Lauren" : (senderNames[m.sender_id] || "Team");
    return `${who}: ${m.body}`;
  }).join("\n\n");

  const claudeMessages = [
    { role: "user", content: `Here's the recent conversation in our team chat:\n\n---\n${transcript}\n---\n\nReply to the latest message. Use tools if you need to look up DCC data.` },
  ];

  // Tool-use loop: Claude may call a tool; we execute, return result, ask
  // for final answer. Cap at 3 rounds so we don't spin if she gets confused.
  let finalText = null;
  for (let round = 0; round < 3; round++) {
    const r = await fetch(ANTHROPIC_API, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages: claudeMessages,
      }),
    });
    if (!r.ok) {
      const errText = await r.text();
      console.error("[lauren-team-respond] Claude error:", r.status, errText);
      // Fail-soft: post a one-line apology so the user knows Lauren saw the message but choked.
      await db.from("team_messages").insert({ thread_id, sender_id: null, sender_kind: "lauren", body: "(Lauren had trouble reaching her brain just now — try again in a sec.)" });
      return json({ error: "claude failed", detail: errText.slice(0, 200) }, 500);
    }
    const data = await r.json();
    const content = data.content || [];

    // If Claude produced text and is done (stop_reason 'end_turn'), we have our answer
    if (data.stop_reason === "end_turn" || data.stop_reason === "stop_sequence") {
      finalText = content.filter(c => c.type === "text").map(c => c.text).join("\n").trim();
      break;
    }

    // Tool-use round
    if (data.stop_reason === "tool_use") {
      claudeMessages.push({ role: "assistant", content });
      const toolUses = content.filter(c => c.type === "tool_use");
      const toolResults = await Promise.all(toolUses.map(async (tu) => {
        try {
          let result;
          if (tu.name === "lookup_deal") {
            const { data } = await db.rpc("lauren_lookup_deal", { p_needle: tu.input.needle });
            result = data;
          } else if (tu.name === "recent_activity") {
            const { data } = await db.rpc("lauren_recent_activity", { p_deal_id: tu.input.deal_id, p_limit: tu.input.limit ?? 10 });
            result = data;
          } else if (tu.name === "upcoming_events") {
            const { data } = await db.rpc("lauren_upcoming_events", { p_window_days: tu.input.window_days ?? 14 });
            result = data;
          } else if (tu.name === "search_contacts") {
            const { data } = await db.rpc("lauren_search_contacts", { p_needle: tu.input.needle });
            result = data;
          } else {
            result = { error: "unknown tool" };
          }
          return { type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(result || []) };
        } catch (e) {
          return { type: "tool_result", tool_use_id: tu.id, content: JSON.stringify({ error: e.message }), is_error: true };
        }
      }));
      claudeMessages.push({ role: "user", content: toolResults });
      continue;
    }

    // Other stop reasons (max_tokens, etc.) — take whatever text we got
    finalText = content.filter(c => c.type === "text").map(c => c.text).join("\n").trim();
    break;
  }

  if (!finalText) finalText = "(Lauren is thinking but didn't quite finish — give her another nudge.)";

  // Insert Lauren's reply
  const { error: insErr } = await db.from("team_messages").insert({
    thread_id,
    sender_id: null,
    sender_kind: "lauren",
    body: finalText,
  });
  if (insErr) {
    console.error("[lauren-team-respond] insert failed:", insErr);
    return json({ error: "insert failed", detail: insErr.message }, 500);
  }

  return json({ ok: true });
});
