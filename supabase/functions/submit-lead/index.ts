import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const NATHAN_PHONE = "+15139518855";

async function textNathan(message: string): Promise<void> {
  const sid = Deno.env.get("TWILIO_ACCOUNT_SID");
  const token = Deno.env.get("TWILIO_AUTH_TOKEN");
  const from = Deno.env.get("TWILIO_FROM_NUMBER");
  if (!sid || !token || !from) return;
  await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${btoa(`${sid}:${token}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: NATHAN_PHONE, From: from, Body: message }).toString(),
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return Response.json({ error: "POST only" }, { status: 405, headers: CORS });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400, headers: CORS });
  }

  const { name, phone, email, address, county, case_number, source, lead_id, notes } = body as Record<string, string>;
  const rawLeadType = (body.lead_type as string) || "surplus";
  const lead_type = ["surplus", "preforeclosure", "other"].includes(rawLeadType) ? rawLeadType : "surplus";
  if (!name) return Response.json({ error: "name required" }, { status: 400, headers: CORS });

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // Slug from last name for the deal ID
  const slug = (name as string).split(" ").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "") || "lead";

  // Route by situation:
  //   surplus        -> surplus deal (former homeowner, funds sitting at court)
  //   preforeclosure -> flip deal   (current homeowner, distressed property opportunity)
  //   other          -> surplus deal with intake_type='other' so Nathan triages manually
  const isFlip = lead_type === "preforeclosure";
  const dealType = isFlip ? "flip" : "surplus";
  const dealStatus = isFlip ? "lead" : "new-lead";
  const idPrefix = isFlip ? "flip" : "sf";
  const dealId = `${idPrefix}-${slug}-${Date.now().toString(36)}`;

  const baseMeta: Record<string, unknown> = {
    county: county || null,
    courtCase: case_number || null,
    homeownerPhone: phone || null,
    homeownerEmail: email || null,
    homeownerName: name,
    lead_source: source || "refundlocators-form",
    case_page_lead_id: lead_id || null,
    intake_type: lead_type,              // record the original classification
    intake_notes: notes || null,
  };

  const meta: Record<string, unknown> = isFlip
    ? {
        ...baseMeta,
        // Flip-track defaults so the deal renders correctly under the flip UI
        contractPrice: 0,
        reinstatement: 0,
        lienPayoff: 0,
        listPrice: 0,
        flatFee: 0,
        buyerAgentPct: 3,
        closingMiscPct: 1,
        concessions: [],
      }
    : {
        ...baseMeta,
        // Surplus-track defaults
        feePct: 25,
        estimatedSurplus: 0,
        attorney: "",
      };

  const { data, error } = await db.from("deals").insert({
    id: dealId,
    name,
    address: address || null,
    type: dealType,
    status: dealStatus,
    meta,
  }).select("id, name, status").single();

  if (error) {
    return Response.json({ error: error.message }, { status: 500, headers: CORS });
  }

  // Headline for the text reflects the situation so Nathan immediately sees the track
  const banner = isFlip
    ? "New PREFORECLOSURE lead"
    : lead_type === "other"
      ? "New lead (situation: other)"
      : "New lead";

  const lines = [
    `${banner} from ${source || "refundlocators.com"}: ${name}`,
    phone ? `Phone: ${phone}` : null,
    address ? `Property: ${address}` : null,
    county ? `County: ${county}` : null,
    `DCC: ${dealId}`,
  ].filter(Boolean).join("\n");
  await textNathan(lines);

  return Response.json({ success: true, deal_id: data.id, lead_type }, { headers: { ...CORS, "Content-Type": "application/json" } });
});
