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

READ TOOLS (always safe to call, no confirm):
- lookup_deal(needle): fuzzy match a deal. Returns up to 5.
- recent_activity(deal_id, limit=10): timeline.
- upcoming_events(window_days=14): hearings + sheriff sales.
- search_contacts(needle): partner attorneys, title companies, etc.
- find_teammate(needle): match a teammate by name/email. Returns user_id.
- lookup_documents(deal_id): list up to 50 files on a deal.
- get_signed_url(document_id): get a temporary URL to open a specific file.

WRITE TOOLS (each PROPOSES an action):
- propose_status_change(deal_id, new_status, reason)
- propose_create_task(deal_id, title, due_date_iso?, assigned_to?)
- propose_update_deal_meta(deal_id, meta_patch, label)
- propose_relay_to_teammate(target_user_id, body): post a Lauren-authored message into the existing teammate DM (Chat tab). Use this for any "tell X" / "loop X in" / "forward to X" intent — Lauren never creates a separate room.
- propose_send_sms(to, body, deal_id?, contact_id?, recipient_label?): text a phone number via the iPhone bridge
- propose_send_email(to, subject, body, deal_id?, recipient_label?): email via Resend
- propose_generate_personalized_url(deal_id): mint a refundlocators.com/s/<token> URL for a lead

BYPASS MODE: each user has a per-account "bypass" toggle. When ON, your propose_* calls auto-fire — no confirm card, the action runs immediately. When OFF (default), the user clicks ✓ Confirm to fire. You don't control the toggle; treat it as transparent. You see it via the response from the tool: if the tool result includes \`executed: true\`, the action ran. If it includes \`note: "Confirm card below…"\`, it's pending. Reply naturally either way — for executed actions, confirm what ran ("Texted Casey at 513-555-…"); for pending, say "Proposed — confirm card below."

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

CRITICAL — TEAMMATE-MESSAGING DISCIPLINE (most important rule in your prompt):

You are an assistant. You do NOT host inter-human conversations. When the user
asks you to communicate with a teammate — by ANY phrasing, including "loop X
in" / "pull X in" / "tell X" / "send to X" / "forward to X" / "bring X in" —
the destination is ALWAYS the existing teammate DM in the Chat tab. You post
a single Lauren-authored message there via propose_relay_to_teammate. You do
NOT create rooms, threads, or any new chat surfaces. The Chat tab is where
humans talk to each other; you stay in your DM.

You do NOT have the ability to communicate with teammates by typing text in
this chat. Typing "Justin — heads up..." does NOT send anything to Justin.
Only a propose_relay_to_teammate call does. Period.

Required sequence:
  1. Call find_teammate(needle) to get target_user_id.
  2. Call propose_relay_to_teammate(target_user_id, target_name, body) where
     body is the full message you want posted in the existing teammate DM —
     written TO the target by name, with all the context they need
     (don't make them ask). Pull from recent activity / lookup_deal as
     needed before composing.
  3. Reply ONE short line in chat: "Proposed — confirm card below." The
     chat will render a confirm/reject card. On confirm, the body gets
     posted into the caller↔target DM. The teammate sees it as an unread
     in their Chat tab.

Sizing: for "loop X in"-style intents (where the target needs full context
to start contributing), the body should be a thorough briefing — not a
curt one-liner. Treat it as the first message of a thread the target will
take over. Include deal name, address, recent activity, and what's expected
of them. For pure "tell X this one thing" intents, keep it short.

NEVER do these things:
- DON'T type a message addressed to a teammate without first calling
  propose_relay_to_teammate. That's a hallucination — the message goes
  nowhere.
- DON'T claim "I already looped X in" or "I sent that" if you have not
  called the tool in THIS turn.
- DON'T ask the user to forward the message themselves. Use the tool.
- DON'T mention rooms, separate threads, or "creating a space for the
  three of us." That isn't how this works anymore.

If the user is vague (e.g. just "loop Justin in" with no topic), pull
context from the recent conversation if obvious; otherwise ask ONE short
question: "What's the context — what should I send him?"

Example:
  User: "loop Justin in on Casey Jennings"
  You: [call lookup_deal("Casey Jennings")] → [call recent_activity(deal_id)] → [call find_teammate("Justin")] → [call propose_relay_to_teammate(<justin_uuid>, "Justin", "Justin — Nathan's looping you in on Casey Jennings (7260 Jerry Drive, West Chester). <full briefing with recent activity, surplus estimate, what's needed from you>.")]
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
    description: "Post a Lauren-authored message into the caller's existing DM with the target teammate (Chat tab). Use this for ANY 'loop X in' / 'tell X' / 'send to X' / 'forward to X' / 'bring X in' intent — Lauren never creates a separate room or thread. For 'loop in'-style intents the body should be a full briefing (deal context, recent activity, what's needed); for one-shot 'tell X' intents it can be short. Call find_teammate first to get target_user_id.",
    input_schema: {
      type: "object",
      properties: {
        target_user_id: { type: "string", description: "uuid from find_teammate" },
        body: { type: "string", description: "Full message to post in the teammate DM — addressed to the target by name. For loop-in intents, include all context the target needs to contribute without asking." },
        target_name: { type: "string", description: "Display name of the recipient (e.g. 'Justin')." },
      },
      required: ["target_user_id", "body"],
    },
  },
  {
    name: "propose_send_sms",
    description: "Send an SMS to a phone number. Routes through the iPhone bridge (Justin's hard rule — Twilio is NOT used for outbound). Use for texting clients, leads, contacts. If the user gives you a contact name/role rather than a number, look up their phone via search_contacts or recent_activity first.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Phone number (E.164 like +15135551234, or 10 digits — will be normalized)" },
        body: { type: "string", description: "Message body (concise, conversational; sign as 'Nathan' or context-appropriate)" },
        deal_id: { type: "string", description: "Optional — link the SMS to a specific deal for activity logging" },
        contact_id: { type: "string", description: "Optional — link to a contacts row" },
        recipient_label: { type: "string", description: "Display name for the confirm card (e.g. 'Casey Jennings')" },
      },
      required: ["to", "body"],
    },
  },
  {
    name: "propose_send_email",
    description: "Send an email via Resend. Use for client/lead/partner emails. From-address auto-set by the send-email function. For internal founder-to-founder messages, use propose_relay_to_teammate (lands in the Chat tab DM) — never email between Nathan and Justin.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string", description: "Subject line" },
        body: { type: "string", description: "Email body — plain text or simple HTML. Sign appropriately." },
        deal_id: { type: "string", description: "Optional — link the email to a deal" },
        recipient_label: { type: "string", description: "Display name for the confirm card" },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "propose_generate_personalized_url",
    description: "Generate a refundlocators.com/s/<token> personalized URL for a lead-phase deal. Same as the manual button on the deal detail page — pulls name/address/county/etc from the deal and creates a personalized_links row. Returns the new URL for use in subsequent SMS/email.",
    input_schema: {
      type: "object",
      properties: {
        deal_id: { type: "string", description: "Deal id (e.g. 'sf-jennings-moa9iqzt')" },
      },
      required: ["deal_id"],
    },
  },
  {
    name: "lookup_documents",
    description: "List up to 50 documents on a deal. Returns id, name, mime_type, size, created_at for each. Useful when the user asks 'what files do we have on X?' or 'find the engagement agreement for Y'.",
    input_schema: {
      type: "object",
      properties: {
        deal_id: { type: "string" },
      },
      required: ["deal_id"],
    },
  },
  {
    name: "get_signed_url",
    description: "Get a temporary signed URL for a specific document so the user can click to open it. Pass document_id from lookup_documents. The URL expires in ~10 minutes.",
    input_schema: {
      type: "object",
      properties: {
        document_id: { type: "string", description: "uuid from lookup_documents" },
      },
      required: ["document_id"],
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

  // Per-user bypass mode — when true, propose_* tools auto-execute
  // instead of waiting for the user to click ✓ Confirm.
  let bypassMode = false;
  if (lastUserSenderId) {
    const { data: bm } = await db.rpc("lauren_get_bypass_mode", { p_user_id: lastUserSenderId });
    bypassMode = bm === true;
  }

  // Helper that wraps the propose-or-auto-execute pattern. Inserts a
  // pending action; in bypass mode immediately fires lauren_execute_action.
  async function proposeOrExecute(action_type: string, action_label: string, action_payload: any) {
    const { data: row, error } = await db.from("lauren_pending_actions").insert({
      thread_id, action_type, action_label, action_payload,
    }).select("id").single();
    if (error) throw error;
    if (bypassMode && lastUserSenderId) {
      const { data: execResult, error: execErr } = await db.rpc("lauren_execute_action", {
        p_action_id: row.id,
        p_caller_id: lastUserSenderId,
      });
      if (execErr) {
        return { proposed: true, action_id: row.id, label: action_label, bypass_failed: execErr.message };
      }
      return { proposed: true, action_id: row.id, label: action_label, executed: true, result: execResult };
    }
    proposedActionIds.push(row.id);
    return { proposed: true, action_id: row.id, label: action_label, note: "Confirm card below — click ✓ to fire." };
  }

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
          } else if (tu.name === "propose_send_sms") {
            const { to, body, deal_id, contact_id, recipient_label } = tu.input;
            const label = `Text ${recipient_label || to}: "${(body || "").slice(0, 80)}${body && body.length > 80 ? "…" : ""}"`;
            result = await proposeOrExecute("send_sms", label, {
              to, body,
              deal_id: deal_id || null,
              contact_id: contact_id || null,
            });
          } else if (tu.name === "propose_send_email") {
            const { to, subject, body, deal_id, recipient_label } = tu.input;
            const label = `Email ${recipient_label || to} · ${subject || "(no subject)"}`;
            result = await proposeOrExecute("send_email", label, {
              to, subject, body,
              deal_id: deal_id || null,
            });
          } else if (tu.name === "propose_generate_personalized_url") {
            const { deal_id } = tu.input;
            const label = `Generate personalized URL for ${deal_id}`;
            result = await proposeOrExecute("generate_personalized_url", label, { deal_id });
          } else if (tu.name === "lookup_documents") {
            const { data } = await db.rpc("lauren_list_documents", { p_deal_id: tu.input.deal_id });
            result = data;
          } else if (tu.name === "get_signed_url") {
            const { data: meta } = await db.rpc("lauren_get_document_url", { p_document_id: tu.input.document_id });
            if (meta?.path) {
              const { data: signed } = await db.storage.from("deal-docs").createSignedUrl(meta.path, 600);
              result = { ...meta, signed_url: signed?.signedUrl || null };
            } else {
              result = { error: "document not found" };
            }
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
