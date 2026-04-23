import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const NATHAN_PHONE = "+15135162306";

async function textNathan(message: string): Promise<boolean> {
  const sid = Deno.env.get("TWILIO_ACCOUNT_SID");
  const token = Deno.env.get("TWILIO_AUTH_TOKEN");
  const from = Deno.env.get("TWILIO_FROM_NUMBER");
  if (!sid || !token || !from) return false;
  const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: { "Authorization": `Basic ${btoa(`${sid}:${token}`)}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: NATHAN_PHONE, From: from, Body: message }).toString(),
  });
  return resp.ok;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: Record<string, string>;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const { access_id } = body;
  if (!access_id) return json({ error: "access_id required" }, 400);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const { data: access } = await db.from("homeowner_intake_access")
    .select("homeowner_name, homeowner_phone, deal_id")
    .eq("id", access_id)
    .single();
  if (!access) return json({ error: "not found" }, 404);

  const { data: deal } = await db.from("deals").select("id, name, address, meta").eq("id", access.deal_id).single();
  const propertyLine = deal?.address || deal?.meta?.propertyAddress || deal?.name || access.deal_id;

  const sent = await textNathan([
    `🏠 HOMEOWNER COMPLETED SURVEY`,
    `${access.homeowner_name || 'Homeowner'} filled out the property questionnaire for ${propertyLine}`,
    access.homeowner_phone ? `Call: ${access.homeowner_phone}` : null,
    `DCC: ${access.deal_id}`,
  ].filter(Boolean).join("\n"));

  return json({ success: true, sms_sent: sent });
});
