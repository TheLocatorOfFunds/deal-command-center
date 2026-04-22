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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: Record<string, string>;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const { offer_id } = body;
  if (!offer_id) return json({ error: "offer_id required" }, 400);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const { data: offer } = await db.from("investor_offers")
    .select("id, deal_id, investor_name, investor_phone, offer_price, financing_type, emd_amount, closing_days, title_company, notes")
    .eq("id", offer_id)
    .single();
  if (!offer) return json({ error: "not found" }, 404);

  const { data: deal } = await db.from("deals")
    .select("id, name, address, meta")
    .eq("id", offer.deal_id)
    .single();

  const propertyLine = deal?.address || deal?.meta?.propertyAddress || deal?.name || offer.deal_id;
  const priceStr = "$" + Number(offer.offer_price).toLocaleString("en-US", { maximumFractionDigits: 0 });
  const terms = [
    offer.financing_type ? offer.financing_type.toUpperCase() : null,
    offer.emd_amount ? "EMD $" + Number(offer.emd_amount).toLocaleString("en-US") : null,
    offer.closing_days ? offer.closing_days + "-day close" : null,
  ].filter(Boolean).join(" · ");

  const lines = [
    `💰 NEW OFFER — ${priceStr}`,
    `${offer.investor_name || 'Investor'} on ${propertyLine}`,
    terms || null,
    offer.title_company ? `Title: ${offer.title_company}` : null,
    offer.investor_phone ? `Call: ${offer.investor_phone}` : null,
    offer.notes ? `Note: ${offer.notes.slice(0, 180)}` : null,
    `DCC: ${offer.deal_id}`,
  ].filter(Boolean).join("\n");

  const sent = await textNathan(lines);
  return json({ success: true, sms_sent: sent });
});
