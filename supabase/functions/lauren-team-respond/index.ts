import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Lauren's response engine for Team Chat. Triggered by the pg trigger on
// team_messages INSERT (see migrations 20260427020000 + 20260427030000).
//
// Phase 2: read-only data lookup tools.
// Phase 3 added: propose_* tools that create a pending action row Nathan
// or Justin must confirm before Lauren actually writes anything.

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

const SYSTEM_PROMPT_BASE = `You are Lauren, an AI teammate and exec assistant for Nathan and Justin at RefundLocators / FundLocators. You're in their internal team chat. Be concise, direct, operational. No fluff, no "I'd be happy to", no excess pleasantries. Plain text only (no markdown headers, no emoji unless the user used one first).

Context:
- RefundLocators recovers surplus funds for foreclosure victims (mostly Ohio).
- Nathan also does fix/flip + wholesale real estate.
- Casey Jennings is an active wholesale deal at 7260 Jerry Drive, West Chester, OH.
- Kevin Daubenmire is the JV partner on Casey Jennings (25% share).

READ TOOLS (always safe to call):
- lookup_deal(needle): fuzzy match a deal. Returns up to 5.
- recent_activity(deal_id, limit=10): timeline.
- upcoming_events(window_days=14): hearings + sheriff sales.
- search_contacts(needle): partner attorneys, title companies, etc.
- find_teammate(needle): match a teammate by name/email. Returns user_id you can use with propose_relay_to_teammate.

WRITE TOOLS (PROPOSE — Nathan or Justin must click confirm in chat to actually run):
- propose_status_change(deal_id, new_status, reason)
- propose_create_task(deal_id, title, due_date_iso?, assigned_to?)
- propose_update_deal_meta(deal_id, meta_patch, label)
- propose_relay_to_teammate(target_user_id, body): forwards the body to your DM with that teammate. Use when the user says "loop X in" / "tell X" / "send this to X". The relayed message will appear in their chat from you (Lauren) with the body. Always look up the teammate via find_teammate first to get the user_id.

Behavior:
- For factual questions: call read tools first, then answer concisely.
- When the user gives an actionable command, call the matching propose_* tool. Don't ask "want me to do X?" — just propose. The chat renders a confirm/reject card under your reply.
- Reply length: 1-3 short paragraphs max.
- If you don't know something and tools can't tell you, say so plainly.`;

const HUB_MODE_ADDENDUM = `

YOU ARE IN A LAUREN DM (your dedicated thread with this user — they have you all to themselves here).
- You always respond here (no @-mention required), but stay quiet on noise.
- If the user is thinking out loud / venting / journaling and there's nothing actionable, reply with a single short word like "noted." or "ok." (or stay completely silent by replying with just ".") — don't lecture, don't summarize their thought back to them, don't suggest things.
- If they ask a question or give a command, act on it.
- Don't proactively suggest features. They know what you can do.

CRITICAL — RELAY DISCIPLINE (this is the most important rule in your prompt):

When the user says "loop X in" / "tell X" / "alert X" / "send this to X" / "forward to X" / "let X know" or anything else that means "communicate this to a teammate" — you MUST call the propose_relay_to_teammate tool. You do NOT have the ability to relay messages by typing text in the chat. Typing "Justin — heads up..." in this chat does NOT send anything to Justin. Only the tool call does.

The required sequence for any relay request:
  1. Call find_teammate(needle) to get the target's user_id (e.g. "Justin" → user_id)
  2. Call propose_relay_to_teammate(target_user_id, body, target_name) with a complete, well-written body. The body is what the recipient will literally see, written in your voice as Lauren on behalf of Nathan/Justin.
  3. THEN reply briefly in chat — one line — confirming what you proposed. The chat will render a confirm/reject card under your message. The user clicks confirm to actually send.

NEVER do these things:
- DON'T type a message addressed to a teammate (like "Justin — heads up...") without first calling propose_relay_to_teammate. That's a hallucination — the message goes nowhere.
- DON'T claim "I already looped X in" or "I told them" if you have not called propose_relay_to_teammate in THIS turn. Past turns don't count.
- DON'T ask the user to forward the message themselves. You have the tool. Use it.

If the body isn't clear from the user's request, ask them ONCE in a short reply: "What do you want me to tell them?" — then wait for their answer before calling the tool. Don't infer a body and relay without confirmation if the user was vague.

Example correct behavior:
  User: "loop Justin in on Casey Jennings"
  You: [call find_teammate("Justin")] → [call propose_relay_to_teammate(<justin_uuid>, "Casey Jennings update — [pull recent activity if needed]", "Justin")]
  You: "Proposed — confirm card below."`;

const TOOLS = [
  // READ
  {
    name: "lookup_deal",
    description: "Fuzzy-match a deal by name, address, or id. Returns up to 5 matches.",
    input_schema: { type: "object", properties: { needle: { type: "string" } }, required: ["needle"] },
  },
  {
    name: "recent_activity",
    description: "Recent activity timeline for a specific deal.",
    input_schema: { type: "object", properties: { deal_id: { type: "string" }, limit: { type: "integer" } }, required: ["deal_id"] },
  },
  {
    name: "upcoming_events",
    description: "Upcoming court hearings + sheriff sales across all deals.",
    input_schema: { type: "object", properties: { window_days: { type: "integer" } } },
  },
  {
    name: "search_contacts",
    description: "Find contacts (partner attorneys, title companies, etc.) by name, company, or kind.",
    input_schema: { type: "object", properties: { needle: { type: "string" } }, required: ["needle"] },
  },
  // WRITE — propose an action that Nathan/Justin must confirm
  {
    name: "propose_status_change",
    description: "Propose changing a deal's status. Creates a confirm/reject card in chat. Use the deal's `id` (e.g. 'sf-jennings-moa9iqzt'), not its display name. new_status must be a valid status string for that deal type.",
    input_schema: {
      type: "object",
      properties: {
        deal_id: { type: "string" },
        new_status: { type: "string" },
        reason: { type: "string", description: "One-line why" },
      },
      required: ["deal_id", "new_status"],
    },
  },
  {
    name: "propose_create_task",
    description: "Propose a new task on a deal. Creates a confirm/reject card in chat.",
    input_schema: {
      type: "object",
      properties: {
        deal_id: { type: "string" },
        title: { type: "string" },
        due_date_iso: { type: "string", description: "ISO date string YYYY-MM-DD, optional" },
        assigned_to: { type: "string", description: "Profile name, optional" },
      },
      required: ["deal_id", "title"],
    },
  },
  {
    name: "propose_update_deal_meta",
    description: "Propose a meta-jsonb patch on a deal (e.g. milestones, partner info). meta_patch is a partial jsonb that gets merged via ||.",
    input_schema: {
      type: "object",
      properties: {
        deal_id: { type: "string" },
        meta_patch: { type: "object" },
        label: { type: "string", description: "One-line description for the confirm card" },
      },
      required: ["deal_id", "meta_patch", "label"],
    },
  },
  {
    name: "find_teammate",
    description: "Match a teammate by name fragment or email. Returns up to 5 teammates with their user_id you can pass to propose_relay_to_teammate.",
    input_schema: {
      type: "object",
      properties: { needle: { type: "string" } },
      required: ["needle"],
    },
  },
  {
    name: "propose_relay_to_teammate",
    description: "Forward / relay a message to the user's DM with another teammate. Use when the user says 'loop X in' / 'tell X' / 'send this to X' / 'forward to X'. The body will appear in the DM from you (Lauren) so the recipient knows it was relayed. Always call find_teammate first to get target_user_id.",
    input_schema: {
      type: "object",
      properties: {
        target_user_id: { type: "string", description: "uuid from find_teammate" },
        body: { type: "string", description: "The message to relay. Include any links/context from the original conversation." },
        target_name: { type: "string", description: "Display name of the recipient (e.g. 'Justin') — for the confirm card label." },
      },
      required: ["target_user_id", "body"],
    },
  },
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ error: "bad JSON" }, 400); }
  const { thread_id } = body;
  if (!thread_id) return json({ error: "thread_id required" }, 400);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "ANTHROPIC_API_KEY not configured" }, 500);

  const db = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));

  // Fetch the thread row so we know whether this is a Lauren DM (Hub mode)
  // or a regular thread (only-respond-on-mention mode).
  const { data: threadRow } = await db
    .from("team_threads")
    .select("id, thread_type, title")
    .eq("id", thread_id)
    .single();
  const isLaurenDm = threadRow?.thread_type === "lauren_dm";

  // Fetch last 15 messages of the thread
  const { data: history } = await db
    .from("team_messages")
    .select("id, sender_id, sender_kind, body, attachments, created_at")
    .eq("thread_id", thread_id)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(15);
  const messages = (history || []).reverse();
  const lastUserMessage = [...messages].reverse().find(m => m.sender_kind !== "lauren");
  const lastUserSenderId = lastUserMessage?.sender_id ?? null;

  const senderIds = [...new Set(messages.filter(m => m.sender_id).map(m => m.sender_id))];
  let senderNames = {};
  if (senderIds.length) {
    const { data: profs } = await db.from("profiles").select("id, display_name, name").in("id", senderIds);
    (profs || []).forEach(p => { senderNames[p.id] = p.display_name || p.name || "Team"; });
  }

  const transcript = messages.map(m => {
    const who = m.sender_kind === "lauren" ? "Lauren" : (senderNames[m.sender_id] || "Team");
    return `${who}: ${m.body}`;
  }).join("\n\n");

  const claudeMessages = [
    { role: "user", content: `Here's the recent conversation in our team chat:\n\n---\n${transcript}\n---\n\nReply to the latest message. Use tools (read or propose_*) when needed. Don't ask permission to look things up — just look. When you'd write data, propose it.` },
  ];

  // Track any actions proposed during this run, so we can link them to
  // Lauren's final message after we insert it.
  const proposedActionIds: string[] = [];

  let finalText = null;
  for (let round = 0; round < 4; round++) {
    const r = await fetch(ANTHROPIC_API, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT_BASE + (isLaurenDm ? HUB_MODE_ADDENDUM : ""),
        tools: TOOLS,
        messages: claudeMessages,
      }),
    });
    if (!r.ok) {
      const errText = await r.text();
      console.error("[lauren-team-respond] Claude error:", r.status, errText);
      await db.from("team_messages").insert({ thread_id, sender_id: null, sender_kind: "lauren", body: "(Lauren had trouble reaching her brain just now — try again in a sec.)" });
      return json({ error: "claude failed", detail: errText.slice(0, 200) }, 500);
    }
    const data = await r.json();
    const content = data.content || [];

    if (data.stop_reason === "end_turn" || data.stop_reason === "stop_sequence") {
      finalText = content.filter(c => c.type === "text").map(c => c.text).join("\n").trim();
      break;
    }

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
          } else if (tu.name === "propose_status_change") {
            const { deal_id, new_status, reason } = tu.input;
            const label = `Set ${deal_id} status → ${new_status}` + (reason ? ` · ${reason}` : "");
            const { data: row, error } = await db.from("lauren_pending_actions").insert({
              thread_id,
              action_type: "update_deal_status",
              action_label: label,
              action_payload: { deal_id, status: new_status, reason: reason || null },
            }).select("id").single();
            if (error) throw error;
            proposedActionIds.push(row.id);
            result = { proposed: true, action_id: row.id, label, note: "A confirm/reject card will appear under your reply. Mention this proposal naturally in your text reply." };
          } else if (tu.name === "propose_create_task") {
            const { deal_id, title, due_date_iso, assigned_to } = tu.input;
            const label = `Create task on ${deal_id}: "${title}"` + (due_date_iso ? ` (due ${due_date_iso})` : "");
            const { data: row, error } = await db.from("lauren_pending_actions").insert({
              thread_id,
              action_type: "create_task",
              action_label: label,
              action_payload: { deal_id, title, due_date: due_date_iso || null, assigned_to: assigned_to || null },
            }).select("id").single();
            if (error) throw error;
            proposedActionIds.push(row.id);
            result = { proposed: true, action_id: row.id, label };
          } else if (tu.name === "propose_update_deal_meta") {
            const { deal_id, meta_patch, label: clientLabel } = tu.input;
            const { data: row, error } = await db.from("lauren_pending_actions").insert({
              thread_id,
              action_type: "update_deal_meta",
              action_label: clientLabel,
              action_payload: { deal_id, meta_patch },
            }).select("id").single();
            if (error) throw error;
            proposedActionIds.push(row.id);
            result = { proposed: true, action_id: row.id, label: clientLabel };
          } else if (tu.name === "find_teammate") {
            const { data } = await db.rpc("lauren_find_teammate", { p_needle: tu.input.needle });
            result = data;
          } else if (tu.name === "propose_relay_to_teammate") {
            const { target_user_id, body, target_name } = tu.input;
            if (!lastUserSenderId) throw new Error("no caller user_id available — cannot relay without a sender");
            const label = `Relay to ${target_name || "teammate"}: "${(body || "").slice(0, 80)}${body && body.length > 80 ? "…" : ""}"`;
            const { data: row, error } = await db.from("lauren_pending_actions").insert({
              thread_id,
              action_type: "relay_to_user",
              action_label: label,
              action_payload: {
                from_user_id: lastUserSenderId,
                to_user_id: target_user_id,
                body,
              },
            }).select("id").single();
            if (error) throw error;
            proposedActionIds.push(row.id);
            result = { proposed: true, action_id: row.id, label, note: "A confirm/reject card will appear under your reply." };
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

    finalText = content.filter(c => c.type === "text").map(c => c.text).join("\n").trim();
    break;
  }

  if (!finalText) finalText = "(Lauren is thinking but didn't quite finish — give her another nudge.)";

  // Hub-mode silent acknowledgement: a bare "." is the sentinel for "noted,
  // staying quiet". Skip inserting Lauren's reply entirely so the chat
  // doesn't get noisy with empty bubbles. The user's message persists.
  if (isLaurenDm && finalText.trim() === ".") {
    return json({ ok: true, silent: true, proposed_actions: proposedActionIds.length });
  }

  // Insert Lauren's reply
  const { data: insertedMsg, error: insErr } = await db.from("team_messages").insert({
    thread_id,
    sender_id: null,
    sender_kind: "lauren",
    body: finalText,
  }).select("id").single();
  if (insErr) {
    console.error("[lauren-team-respond] insert failed:", insErr);
    return json({ error: "insert failed", detail: insErr.message }, 500);
  }

  // Link any proposed actions to this message so the UI can render the
  // confirm/reject cards directly under the message that proposed them.
  if (proposedActionIds.length && insertedMsg?.id) {
    await db.from("lauren_pending_actions")
      .update({ message_id: insertedMsg.id })
      .in("id", proposedActionIds);
  }

  return json({ ok: true, proposed_actions: proposedActionIds.length });
});
