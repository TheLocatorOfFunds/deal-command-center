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

// Investor portal hits this to resolve a document id into a short-lived
// signed URL for display/download. Token-gated: caller must supply a valid
// investor_deal_access token AND the document must belong to that deal AND
// be flagged investor_visible=true.
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: Record<string, string>;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const { token, document_id } = body;
  if (!token || !document_id) return json({ error: "token + document_id required" }, 400);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const { data: doc } = await db
    .from("documents")
    .select("id, path, investor_visible, deal_id")
    .eq("id", document_id)
    .eq("investor_visible", true)
    .single();
  if (!doc) return json({ error: "not found" }, 404);

  const { data: access } = await db
    .from("investor_deal_access")
    .select("id")
    .eq("token", token)
    .eq("deal_id", doc.deal_id)
    .eq("enabled", true)
    .is("revoked_at", null)
    .maybeSingle();
  if (!access) return json({ error: "access denied" }, 403);

  const { data: signed, error: se } = await db.storage.from("deal-docs").createSignedUrl(doc.path, 600);
  if (se || !signed?.signedUrl) return json({ error: "could not sign url" }, 500);
  return json({ url: signed.signedUrl, path: doc.path });
});
