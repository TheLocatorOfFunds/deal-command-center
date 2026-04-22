import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const PROMPT = `You are writing a short, sharp real-estate investor-facing listing description for a wholesale or wholetail deal being promoted by RefundLocators (Nathan Johnson, Ohio). Your audience is experienced flippers, landlords, and cash buyers evaluating many deals per week.

Input below is a JSON blob of every known fact about the property: pricing, ARV, rehab estimate + scope, condition/mechanicals, occupancy, auction status if preforeclosure, property stats, and AI-extracted court document summaries.

Write a 2-3 paragraph description that:
- Leads with the spread opportunity (Asking vs ARV minus Rehab) in the first sentence
- Names the city/county and 1-2 property highlights (bed/bath/sqft, year built, any standout feature)
- Summarizes condition honestly: what's been updated, what needs work, and any known issues. No sugarcoating.
- If preforeclosure: mention the auction deadline as urgency without being alarmist
- Close with a strong one-line CTA like "Call Nathan at (513) 951-8855 for a walkthrough" or similar
- Total length: 120-220 words
- Tone: direct, credible, data-forward. Not flowery. No emoji. No hype words like "GEM" or "MUST SEE".
- Numbers: format money as $XXX,XXX. Never show rehab as exact to-the-dollar; use ranges or approximate.
- Do NOT fabricate any fact not present in the input JSON. If something isn't known, don't mention it.

Output ONLY the listing copy text. No preamble, no markdown, no section headers.`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const authHeader = req.headers.get("Authorization") || req.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ") || authHeader.length < 20) {
    return json({ error: "Unauthorized" }, 401);
  }

  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return json({ error: "ANTHROPIC_API_KEY not configured" }, 503);

  let body: Record<string, string>;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const { deal_id } = body;
  if (!deal_id) return json({ error: "deal_id required" }, 400);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const { data: deal } = await db.from("deals").select("id, name, address, type, status, meta").eq("id", deal_id).single();
  if (!deal) return json({ error: "deal not found" }, 404);

  const { data: docs } = await db.from("documents")
    .select("name, extracted")
    .eq("deal_id", deal_id)
    .eq("extraction_status", "done")
    .limit(20);

  const facts = {
    address: deal.address,
    city_county: deal.meta?.county,
    type: deal.type,
    investor: deal.meta?.investor || {},
    document_summaries: (docs || []).map(d => ({ name: d.name, summary: d.extracted?.summary, type: d.extracted?.document_type })).filter(d => d.summary),
  };

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 700,
      messages: [{ role: "user", content: PROMPT + "\n\nFacts JSON:\n" + JSON.stringify(facts, null, 2) }],
    }),
  });

  if (!resp.ok) return json({ error: "Claude error", detail: (await resp.text()).slice(0, 400) }, 500);
  const result = await resp.json();
  const text = result.content?.[0]?.text || "";
  return json({ success: true, listing_copy: text.trim() });
});
