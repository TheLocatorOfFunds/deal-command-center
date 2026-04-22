import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

const NATHAN_PHONE = "+15139518855";

async function textNathan(message: string): Promise<boolean> {
  const sid = Deno.env.get("TWILIO_ACCOUNT_SID");
  const token = Deno.env.get("TWILIO_AUTH_TOKEN");
  const from = Deno.env.get("TWILIO_FROM_NUMBER");
  if (!sid || !token || !from) return false;
  const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${btoa(`${sid}:${token}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: NATHAN_PHONE, From: from, Body: message }).toString(),
  });
  return resp.ok;
}

// Portal calls this right after submit_walkthrough_request RPC succeeds.
// Reads the new request + deal, formats an SMS, sends via Twilio. Fire-and
// -forget from the portal's perspective (the RPC already logged activity
// and created the row, this is just the phone ping).
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: Record<string, string>;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const { request_id } = body;
  if (!request_id) return json({ error: "request_id required" }, 400);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const { data: wr, error } = await db.from("walkthrough_requests")
    .select("id, deal_id, investor_name, investor_phone, investor_email, preferred_time, investor_note, created_at")
    .eq("id", request_id)
    .single();
  if (error || !wr) return json({ error: "not found" }, 404);

  const { data: deal } = await db.from("deals")
    .select("id, name, address, meta")
    .eq("id", wr.deal_id)
    .single();

  const propertyLine = (deal?.address) || (deal?.meta?.propertyAddress) || deal?.name || wr.deal_id;
  const lines = [
    `🏠 WALKTHROUGH REQUEST`,
    `${wr.investor_name || 'An investor'} wants to see ${propertyLine}`,
    wr.preferred_time ? `When: ${wr.preferred_time}` : null,
    wr.investor_phone ? `Call: ${wr.investor_phone}` : null,
    wr.investor_email ? `Email: ${wr.investor_email}` : null,
    wr.investor_note ? `Note: ${wr.investor_note}` : null,
    `DCC: ${wr.deal_id}`,
  ].filter(Boolean).join("\n");

  const sent = await textNathan(lines);

  return json({ success: true, sms_sent: sent });
});
