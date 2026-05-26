// lauren-voice — Vapi Custom LLM endpoint for inbound voice calls.
//
// Vapi config: Custom LLM URL → https://<project>.supabase.co/functions/v1/lauren-voice
// Auth header: Authorization: Bearer ${VAPI_LLM_SECRET}
//
// Contract: OpenAI-compatible /chat/completions with stream=true. Vapi
// sends each conversation turn (full message history + Vapi metadata
// like the caller's phone number); we translate to Anthropic Messages,
// stream Claude's reply back, and re-emit as OpenAI-format SSE chunks.
//
// Lauren's system prompt + safety filters live in _shared/lauren-brain.ts
// — same brain as the web widget. Voice-specific behavior (1-2 sentence
// replies, no URLs, etc.) is layered via VOICE_ADDENDUM.
//
// First-turn behavior:
//   - Look up the caller's phone number → contact → most-recent deal
//   - Pack that into a [CASE_CONTEXT] block appended to the system prompt
//   - Lauren greets the caller by name and confirms which case they're calling about
//
// No tool calls in v1 — Claude responds straight from the (caller-context-
// enriched) system prompt. Adding tools later is non-breaking; for now,
// skipping them keeps voice-turn latency under Vapi's 2-second budget.
//
// Deploy with verify_jwt=false (Vapi has no Supabase JWT).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  SYSTEM,
  VOICE_ADDENDUM,
  screenInput,
  sanitizeReply,
  REFUSAL_REPLY,
  resolveCallerContext,
  normalizePhone,
} from "../_shared/lauren-brain.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ─── OpenAI ↔ Anthropic message translation ────────────────────────
// Vapi sends messages in OpenAI format ({ role: 'user'|'assistant'|'system'|'tool', content: string }).
// Anthropic expects only 'user' and 'assistant' roles with a separate top-level 'system' string.
// We pull system messages out and pass them as Anthropic's system field.

function translateMessages(openaiMessages: any[]): {
  anthropicMessages: any[];
  inlineSystem: string;
} {
  const inlineSystemParts: string[] = [];
  const anthropicMessages: any[] = [];

  for (const m of openaiMessages || []) {
    if (!m || typeof m !== "object") continue;
    const role = String(m.role || "").toLowerCase();
    const content = typeof m.content === "string"
      ? m.content
      : Array.isArray(m.content)
        ? m.content.map((c: any) => (typeof c === "string" ? c : c?.text || "")).join(" ")
        : "";

    if (role === "system") {
      inlineSystemParts.push(content);
      continue;
    }
    if (role === "user" || role === "assistant") {
      anthropicMessages.push({ role, content });
      continue;
    }
    if (role === "tool" || role === "function") {
      // Vapi rarely sends these in Custom LLM mode, but if it does, surface
      // them as user-side observations so Claude has the context.
      anthropicMessages.push({ role: "user", content: `[tool result] ${content}` });
    }
  }

  // Collapse adjacent same-role messages (Anthropic requires alternation).
  const collapsed: any[] = [];
  for (const m of anthropicMessages) {
    const prev = collapsed[collapsed.length - 1];
    if (prev && prev.role === m.role) {
      prev.content = `${prev.content}\n\n${m.content}`;
    } else {
      collapsed.push({ ...m });
    }
  }
  // Anthropic requires the first message to be 'user'. If somehow it's not,
  // prepend a placeholder so the call doesn't 400.
  if (collapsed.length > 0 && collapsed[0].role !== "user") {
    collapsed.unshift({ role: "user", content: "(call connecting)" });
  }
  if (collapsed.length === 0) {
    collapsed.push({ role: "user", content: "(hello)" });
  }

  return {
    anthropicMessages: collapsed,
    inlineSystem: inlineSystemParts.join("\n\n"),
  };
}

// ─── Caller-phone extraction ────────────────────────────────────────
// Vapi injects call metadata into Custom LLM requests. The exact path
// has shifted between API versions, so check several known shapes.

function extractCallerPhone(body: any): string | null {
  const candidates = [
    body?.call?.customer?.number,
    body?.call?.customer?.phoneNumber,
    body?.customer?.number,
    body?.customer?.phoneNumber,
    body?.phoneNumber?.number,
    body?.phoneNumber,
    body?.metadata?.callerNumber,
    body?.metadata?.caller_phone,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.length >= 7) return normalizePhone(c);
  }
  return null;
}

// ─── OpenAI SSE chunk emitter ───────────────────────────────────────

function openaiChunk(id: string, model: string, delta: any, finishReason: string | null = null) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

// ─── Anthropic SSE → OpenAI SSE translation stream ──────────────────

async function streamAnthropicAsOpenAI(
  anthropicResp: Response,
  model: string,
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
) {
  const id = "chatcmpl-" + crypto.randomUUID();

  // Open with the role declaration chunk OpenAI clients expect.
  controller.enqueue(
    encoder.encode(`data: ${JSON.stringify(openaiChunk(id, model, { role: "assistant", content: "" }))}\n\n`),
  );

  const reader = anthropicResp.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let collectedText = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) continue;
      const payload = trimmed.slice(6);
      if (!payload || payload === "[DONE]") continue;
      try {
        const evt = JSON.parse(payload);
        if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
          const text = evt.delta.text || "";
          collectedText += text;
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(openaiChunk(id, model, { content: text }))}\n\n`),
          );
        }
      } catch (_) {
        // Tolerate malformed events; keep streaming.
      }
    }
  }

  // Final chunk + DONE marker.
  controller.enqueue(
    encoder.encode(`data: ${JSON.stringify(openaiChunk(id, model, {}, "stop"))}\n\n`),
  );
  controller.enqueue(encoder.encode(`data: [DONE]\n\n`));

  // Sanity check: if the model produced output that would trip our
  // sanitizer (system-prompt leak, disallowed link), we can't unsend
  // it after streaming. Log so we can spot it in observability.
  const cleaned = sanitizeReply(collectedText);
  if (cleaned !== collectedText.slice(0, 4000)) {
    console.warn("lauren-voice: output sanitizer would have modified streamed reply", {
      original_len: collectedText.length,
      cleaned_len: cleaned.length,
    });
  }
}

// ─── Server ─────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (req.method !== "POST") {
    return new Response("POST only", { status: 405, headers: CORS });
  }

  // Auth: Bearer token Vapi sends per the Custom LLM header config.
  const expectedSecret = Deno.env.get("VAPI_LLM_SECRET") ?? "";
  if (!expectedSecret) {
    return Response.json({ error: "VAPI_LLM_SECRET not configured" }, { status: 503, headers: CORS });
  }
  const authHeader = req.headers.get("authorization") ?? "";
  const presentedSecret = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : authHeader;
  if (presentedSecret !== expectedSecret) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers: CORS });
  }

  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!anthropicKey) {
    return Response.json({ error: "ANTHROPIC_API_KEY not set" }, { status: 503, headers: CORS });
  }

  let body: any;
  try {
    body = await req.json();
  } catch (e) {
    return Response.json({ error: "invalid_json: " + String(e) }, { status: 400, headers: CORS });
  }

  const { anthropicMessages, inlineSystem } = translateMessages(body?.messages || []);
  const callerPhone = extractCallerPhone(body);
  const requestedStream = body?.stream !== false; // default true; Vapi always wants streaming

  // Input firewall — same patterns as the web chat, applied to the last user turn.
  const screen = screenInput(anthropicMessages);
  if (!screen.ok) {
    // Synthesize a refusal in OpenAI streaming format and return.
    return streamingRefusal(REFUSAL_REPLY, requestedStream);
  }

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // First-turn caller resolution. We do it on every turn (Vapi sends
  // the full transcript each time) — cheap, and means we don't have to
  // track per-call state on our side. The DB lookup is two indexed
  // selects; ~30ms typical.
  const callerContext = await resolveCallerContext(db, callerPhone);

  const systemPrompt = [
    SYSTEM,
    VOICE_ADDENDUM,
    inlineSystem ? `\n${inlineSystem}` : "",
    callerContext ? `\n[CASE_CONTEXT — this caller's specific case data, scope all answers to this case only]\n${callerContext}` : "",
  ].filter(Boolean).join("\n");

  // ─── Call Anthropic with streaming ────────────────────────────────
  const anthropicResp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 256, // tight cap — voice replies are 1-2 sentences
      system: systemPrompt,
      messages: anthropicMessages,
      stream: true,
    }),
  });

  if (!anthropicResp.ok || !anthropicResp.body) {
    const txt = await anthropicResp.text().catch(() => "");
    return Response.json(
      { error: `anthropic_${anthropicResp.status}`, detail: txt.slice(0, 300) },
      { status: 502, headers: CORS },
    );
  }

  if (!requestedStream) {
    // Non-streaming fallback path — collect everything, return a single
    // OpenAI chat completion. Vapi shouldn't hit this in normal operation.
    const full = await collectAnthropicNonStreaming(anthropicResp);
    return Response.json(
      {
        id: "chatcmpl-" + crypto.randomUUID(),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "claude-sonnet-4-5",
        choices: [{
          index: 0,
          message: { role: "assistant", content: sanitizeReply(full) },
          finish_reason: "stop",
        }],
      },
      { headers: { ...CORS, "Content-Type": "application/json" } },
    );
  }

  // Streaming path — translate Anthropic SSE → OpenAI SSE on the fly.
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        await streamAnthropicAsOpenAI(anthropicResp, "claude-sonnet-4-5", controller, encoder);
      } catch (err) {
        console.error("lauren-voice stream error:", err);
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ error: String(err) })}\n\n`),
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      ...CORS,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
});

async function collectAnthropicNonStreaming(anthropicResp: Response): Promise<string> {
  const reader = anthropicResp.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data: ")) continue;
      const payload = t.slice(6);
      if (!payload || payload === "[DONE]") continue;
      try {
        const evt = JSON.parse(payload);
        if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
          text += evt.delta.text || "";
        }
      } catch (_) { /* ignore */ }
    }
  }
  return text;
}

function streamingRefusal(text: string, asStream: boolean): Response {
  if (!asStream) {
    return Response.json(
      {
        id: "chatcmpl-" + crypto.randomUUID(),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "claude-sonnet-4-5",
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      },
      { headers: { ...CORS, "Content-Type": "application/json" } },
    );
  }
  const id = "chatcmpl-" + crypto.randomUUID();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(openaiChunk(id, "claude-sonnet-4-5", { role: "assistant", content: "" }))}\n\n`));
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(openaiChunk(id, "claude-sonnet-4-5", { content: text }))}\n\n`));
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(openaiChunk(id, "claude-sonnet-4-5", {}, "stop"))}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      ...CORS,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}
