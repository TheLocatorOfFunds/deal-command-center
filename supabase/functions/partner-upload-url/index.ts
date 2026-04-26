import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Mints a signed PUT URL so the JV partner can upload files (especially
// videos) directly to Supabase Storage, bypassing the Edge Function's
// request-body size limit. Used for any file > a few MB.
//
// Flow:
//   1. Browser calls partner_request_upload RPC → returns {document_id, path}
//   2. Browser POSTs {token, path} to this function → returns {signedUrl, token}
//   3. Browser PUTs the file body to signedUrl directly
//   4. Browser calls partner_finalize_upload RPC → marks complete + activity
//
// Validation: we re-check the token + that the path belongs to that
// partner's deal before minting the URL. So even if someone steals a
// document_id from the network panel, they can't get an upload URL for
// a file they don't own.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-partner-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const token = req.headers.get("x-partner-token") ||
    new URL(req.url).searchParams.get("token");
  if (!token) return json({ error: "missing partner token" }, 401);

  let body;
  try { body = await req.json(); } catch { return json({ error: "bad JSON" }, 400); }
  const { path, document_id } = body;
  if (!path || !document_id) return json({ error: "path + document_id required" }, 400);

  const db = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));

  // Validate token + that this document_id was created for this partner
  const { data: access } = await db
    .from("partner_deal_access")
    .select("id, deal_id, enabled, revoked_at")
    .eq("token", token)
    .maybeSingle();
  if (!access) return json({ error: "invalid token" }, 403);
  if (!access.enabled || access.revoked_at) return json({ error: "access revoked" }, 403);

  const { data: doc } = await db
    .from("documents")
    .select("id, path, deal_id, uploaded_by_partner_access_id, upload_state")
    .eq("id", document_id)
    .maybeSingle();
  if (!doc) return json({ error: "doc not found" }, 404);
  if (doc.uploaded_by_partner_access_id !== access.id) return json({ error: "doc not yours" }, 403);
  if (doc.deal_id !== access.deal_id) return json({ error: "deal mismatch" }, 403);
  if (doc.path !== path) return json({ error: "path mismatch" }, 403);
  if (doc.upload_state !== "pending") return json({ error: "doc not pending" }, 409);

  const { data: signed, error: se } = await db.storage
    .from("deal-docs")
    .createSignedUploadUrl(path);
  if (se || !signed?.signedUrl) {
    return json({ error: "could not sign upload url: " + (se?.message || "unknown") }, 500);
  }

  return json({ signedUrl: signed.signedUrl, token: signed.token, path: signed.path });
});
