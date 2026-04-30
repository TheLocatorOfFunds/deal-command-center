// lauren-recording-summary — summarize a screen recording's transcript.
//
// Per Nathan 2026-04-29: Inaam was using Loom for case-cleaning videos.
// We replicated the workflow inside DCC. Browser captures screen + mic
// via getDisplayMedia + getUserMedia, AND runs the free Web Speech API
// concurrently to transcribe the mic audio in real-time. The video goes
// to the screen-recordings bucket, the transcript text goes onto the
// screen_recordings row. This EF then reads the transcript and asks
// Claude to write a short, useful summary that lives on the row + shows
// up under the recording on the deal Files tab.
//
// Input  : { recording_id }
// Output : { ai_summary }   (also written to screen_recordings.ai_summary)
//
// Idempotent — safe to call again if the first call failed mid-way.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5-20251001";  // fast + cheap; transcripts are short
const MAX_TOKENS = 500;

const SYSTEM_PROMPT = `You are Lauren, summarizing a screen recording someone on the team made. They were narrating their work on a real estate / surplus-recovery case while screen-sharing. The transcript below is the audio narration captured live by the browser's speech-to-text — it may have typos, weird capitalization, or skipped words.

Write a SHORT useful summary (3-6 short bullet points, max ~80 words total) that another teammate could read in 10 seconds to know what was demonstrated. Focus on:
- What case / deal / topic this was about (use proper nouns the speaker mentioned)
- The 2-4 key actions or decisions shown
- Anything notable that another teammate should know (gotcha, change of approach, question raised)

Voice rules:
- Plain bullets, "- " prefix, one per line
- Past tense ("walked through", "showed", "explained")
- No fluff, no "the speaker discussed", just the content
- Skip generic stuff ("opened the deal page") — only what's specific
- If the transcript is too short or unclear to summarize, return "(Recording too short or unclear to summarize.)" and nothing else

Output the bullets directly. No headings, no preamble, no JSON wrapper.`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "ANTHROPIC_API_KEY not configured" }, 500);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(supabaseUrl, supabaseServiceKey, { auth: { persistSession: false } });

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid JSON body" }, 400); }
  const { recording_id } = body || {};
  if (!recording_id) return json({ error: "recording_id required" }, 400);

  // Read the row.
  const { data: rec, error: readErr } = await sb
    .from("screen_recordings")
    .select("id, title, transcript, deal_id, ai_summary_status")
    .eq("id", recording_id)
    .maybeSingle();
  if (readErr) return json({ error: "could not read recording", detail: readErr.message }, 500);
  if (!rec) return json({ error: "recording not found" }, 404);

  const transcript = (rec.transcript || "").trim();
  if (!transcript) {
    // No transcript yet — mark as such, return cleanly.
    await sb.from("screen_recordings")
      .update({ ai_summary: "(No voice narration captured.)", ai_summary_status: "done" })
      .eq("id", recording_id);
    return json({ ai_summary: "(No voice narration captured.)" });
  }

  // Mark running.
  await sb.from("screen_recordings")
    .update({ ai_summary_status: "running" })
    .eq("id", recording_id);

  // Build the Claude call.
  const userMsg = `Recording title: ${rec.title || "(untitled)"}
Linked deal: ${rec.deal_id || "(none)"}

TRANSCRIPT (speech-to-text from the screen recording):
${transcript}

Summarize per your system prompt.`;

  let claudeResp: Response;
  try {
    claudeResp = await fetch(ANTHROPIC_API, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMsg }],
      }),
    });
  } catch (e) {
    await sb.from("screen_recordings")
      .update({ ai_summary_status: "failed" }).eq("id", recording_id);
    return json({ error: "claude fetch failed", detail: String(e) }, 502);
  }

  if (!claudeResp.ok) {
    const txt = await claudeResp.text();
    await sb.from("screen_recordings")
      .update({ ai_summary_status: "failed" }).eq("id", recording_id);
    return json({ error: "claude returned non-200", status: claudeResp.status, detail: txt }, 502);
  }

  const data = await claudeResp.json();
  const summary: string = (data?.content?.[0]?.text || "").trim();

  await sb.from("screen_recordings")
    .update({ ai_summary: summary, ai_summary_status: "done" })
    .eq("id", recording_id);

  return json({ ai_summary: summary });
});
