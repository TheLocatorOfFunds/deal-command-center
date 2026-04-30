// lauren-eod-polish — one-shot EOD-report polish.
//
// Per Nathan 2026-04-29: the EOD modal asks Eric / Inaam / the team to
// fill three fields (worked_on / blocked / next_up). Some teammates write
// crisp bullets; some brain-dump in run-on sentences; some only fill one
// field. This EF lets them dump raw context + click "✨ Polish with
// Lauren" — Lauren rewrites the three fields in clean operational form
// before they hit Submit.
//
// Lives in its own EF (not lauren-team-respond) on purpose: no tools, no
// thread, no deal — just a stateless one-shot polish. Keeps Justin's
// Lauren brain unchanged.
//
// Input  : { worked_on, blocked, next_up, brain_dump, user_name }
// Output : { worked_on, blocked, next_up }   (cleaned versions)

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5-20251001";  // fast + cheap for this one-shot
const MAX_TOKENS = 800;

const SYSTEM_PROMPT = `You are Lauren, an AI teammate at RefundLocators. Your job here is narrow: polish a teammate's end-of-day standup report. The team uses these EOD reports in their internal Chat tab in lieu of a daily standup meeting.

Voice rules (these are the team's voice — match them exactly):
- Terse, operational, no fluff. No "I'd be happy to", no "Great work today!", no exclamation points.
- Plain bullet points, one per line, starting with "- " or "•".
- Past tense for "worked on" (got X done). Present tense for "blocked" (waiting on Y). Future tense for "next up" (will do Z tomorrow).
- Keep proper nouns and case names exactly as the user wrote them — don't reformat "Casey Jennings" or "5052 State Road 252".

What to do:
- Read the user's draft for each field PLUS their brain dump.
- Distribute the brain-dump content into the appropriate field (work-done items into worked_on, blockers into blocked, plans into next_up).
- Tighten run-on sentences into bullets. Combine duplicates. Keep every distinct fact the user mentioned.
- If the user already wrote clean bullets, leave them mostly alone — just fix obvious typos / capitalization.
- If a field has nothing in the draft AND nothing in the brain dump pertains to it, return null for that field. Don't invent content.

Hard rules:
- Do NOT invent facts the user didn't provide. If they said "worked on the import bug" don't expand it to "fixed the GHL CSV import bug that was causing orphan deals" unless they wrote that.
- Do NOT add commentary, headings, or framing text. Just the polished bullets.
- Do NOT add emoji unless the user used them first.

Output format — STRICT:
Return ONLY a valid JSON object with exactly these three keys, nothing else:
{"worked_on": "...", "blocked": "...", "next_up": "..."}

If a field has no content, use null (not empty string). No prose before or after the JSON.`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "ANTHROPIC_API_KEY not configured" }, 500);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const { worked_on, blocked, next_up, brain_dump, user_name } = body || {};

  // At minimum we need SOMETHING to polish.
  const hasAny = [worked_on, blocked, next_up, brain_dump]
    .some((v) => typeof v === "string" && v.trim().length > 0);
  if (!hasAny) return json({ error: "nothing to polish — fill at least one field" }, 400);

  const userMsg = `Teammate: ${user_name || "(unspecified)"}
Date: ${new Date().toISOString().slice(0, 10)}

DRAFT — what did you work on today:
${(worked_on || "").trim() || "(empty)"}

DRAFT — anything blocked:
${(blocked || "").trim() || "(empty)"}

DRAFT — what's next tomorrow:
${(next_up || "").trim() || "(empty)"}

BRAIN DUMP — extra context to weave in (may be unstructured):
${(brain_dump || "").trim() || "(none)"}

Polish into the JSON format specified in your system prompt. JSON only — no prose.`;

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
    return json({ error: "claude fetch failed", detail: String(e) }, 502);
  }

  if (!claudeResp.ok) {
    const txt = await claudeResp.text();
    return json({ error: "claude returned non-200", status: claudeResp.status, detail: txt }, 502);
  }

  const data = await claudeResp.json();
  const text: string = data?.content?.[0]?.text || "";

  // Extract JSON. Claude usually returns clean JSON because of the system
  // prompt, but defensively strip any code fences.
  let parsed: { worked_on: string | null; blocked: string | null; next_up: string | null };
  try {
    const cleaned = text.trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
    parsed = JSON.parse(cleaned);
  } catch (e) {
    return json({ error: "could not parse Lauren's reply as JSON", raw: text }, 502);
  }

  return json({
    worked_on: parsed.worked_on ?? null,
    blocked: parsed.blocked ?? null,
    next_up: parsed.next_up ?? null,
  });
});
