import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-partner-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

// JV partner uploads a file (typically a photo) into the deal's storage
// bucket via the partner portal. Token-gated — caller must supply a valid
// partner_deal_access token. Uploads land at deal-docs/{deal_id}/partner/
// {timestamp}-{name}, get a documents row with partner_visible=true and
// uploaded_by_partner_access_id set, and log an activity row so Nathan
// sees "Kevin uploaded: front.jpg" in DCC.
//
// 25 MB cap per file (photos from a phone are usually 2-8 MB).
const MAX_BYTES = 25 * 1024 * 1024;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const token = req.headers.get("x-partner-token") ||
    new URL(req.url).searchParams.get("token");
  if (!token) return json({ error: "missing partner token" }, 401);

  const ct = req.headers.get("content-type") || "";
  if (!ct.includes("multipart/form-data")) {
    return json({ error: "expected multipart/form-data with a 'file' field" }, 400);
  }

  let form: FormData;
  try { form = await req.formData(); } catch { return json({ error: "bad form data" }, 400); }
  const file = form.get("file");
  if (!(file instanceof File)) return json({ error: "no file in 'file' field" }, 400);
  if (file.size === 0) return json({ error: "empty file" }, 400);
  if (file.size > MAX_BYTES) return json({ error: `file too large (${(file.size/1024/1024).toFixed(1)} MB > 25 MB cap)` }, 413);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // Validate token + get the deal it's tied to
  const { data: access } = await db
    .from("partner_deal_access")
    .select("id, deal_id, partner_name, enabled, revoked_at")
    .eq("token", token)
    .maybeSingle();
  if (!access) return json({ error: "invalid token" }, 403);
  if (!access.enabled || access.revoked_at) return json({ error: "access revoked" }, 403);

  // Sanitize filename — keep extension, strip everything else exotic
  const safeName = (file.name || "upload").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  const ts = Date.now();
  const path = `${access.deal_id}/partner/${ts}-${safeName}`;

  // Upload to storage
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { error: upErr } = await db.storage.from("deal-docs").upload(path, bytes, {
    contentType: file.type || "application/octet-stream",
    upsert: false,
  });
  if (upErr) return json({ error: "upload failed: " + upErr.message }, 500);

  // Insert documents row with partner_visible + attribution
  const { data: doc, error: docErr } = await db.from("documents").insert({
    deal_id: access.deal_id,
    name: safeName,
    path,
    size: file.size,
    partner_visible: true,
    uploaded_by_partner_access_id: access.id,
    uploaded_by_partner_at: new Date().toISOString(),
    extraction_status: "pending",
  }).select().single();

  if (docErr) {
    // Best-effort cleanup of the orphaned storage object
    await db.storage.from("deal-docs").remove([path]).catch(() => {});
    return json({ error: "could not record upload: " + docErr.message }, 500);
  }

  // Activity log so Nathan sees it in DCC
  await db.from("activity").insert({
    deal_id: access.deal_id,
    user_id: null,
    action: `${access.partner_name || "Partner"} uploaded: ${safeName}`,
  }).then(() => {}).catch(() => {});

  return json({ ok: true, document_id: doc.id, path });
});
