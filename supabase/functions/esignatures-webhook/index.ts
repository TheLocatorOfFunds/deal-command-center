/**
 * esignatures-webhook — ingest event callbacks from eSignatures.com
 *
 * Receives the 10 webhook event types from eSignatures.com and updates the
 * matching esignatures_contracts row + writes an activity row.
 *
 * Event types (per eSignatures.com docs):
 *   - contract-sent-to-signer
 *   - signer-viewed-the-contract
 *   - signer-signed
 *   - contract-signed                 (all signers complete)
 *   - signer-declined
 *   - contract-withdrawn
 *   - signer-mobile-update-request
 *   - sms-incoming
 *   - contract-reminder-sent-to-signer
 *   - error
 *
 * Auth: this EF is registered with the vendor's webhook endpoint URL and
 * uses a shared secret in a query param (?secret=...) — same pattern as
 * intel-sync / docket-webhook. The shared secret must match the
 * ESIGNATURES_WEBHOOK_SECRET env var.
 *
 * Deployed with verify_jwt=false (their webhook system sends no
 * Authorization header).
 *
 * Env:
 *   ESIGNATURES_WEBHOOK_SECRET — shared secret in the webhook URL
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto-injected)
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const SHARED_SECRET = Deno.env.get("ESIGNATURES_WEBHOOK_SECRET");

  if (!SHARED_SECRET) {
    return json({
      error: "not_configured",
      message: "ESIGNATURES_WEBHOOK_SECRET not set in EF secrets.",
    }, 500);
  }

  // Validate the shared secret. eSignatures.com supports a query-string
  // secret on the webhook URL (the URL you register in their dashboard
  // is "https://<project>.functions.supabase.co/esignatures-webhook?secret=ABC123").
  const url = new URL(req.url);
  const incomingSecret = url.searchParams.get("secret");
  if (incomingSecret !== SHARED_SECRET) {
    return json({ error: "unauthorized" }, 401);
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "bad_json" }, 400);
  }

  // eSignatures.com payload shape: { event_type, data: { contract: { id, status, signers, metadata, ... } } }
  // We defensively handle a couple of variations.
  const eventType: string = payload?.event_type || payload?.type || "unknown";
  const contractObj: any =
    payload?.data?.contract ||
    payload?.contract ||
    payload?.data ||
    payload;

  const contractId: string | undefined = contractObj?.id || contractObj?.contract_id;
  if (!contractId) {
    // We can't reconcile — record it to a fallback table or just log+200 so
    // they don't retry indefinitely. Logging + 200 is the right move; we'll
    // see it in EF logs if it ever fires.
    console.warn("[esignatures-webhook] no contract id in payload — event ignored:", eventType);
    return json({ ok: true, ignored: true });
  }

  // Locate our row by contract_id. Insert a stub if missing (the contract
  // was created out-of-band via the eSignatures.com dashboard — rare, but
  // we shouldn't drop the event).
  const { data: existing } = await sb
    .from("esignatures_contracts")
    .select("id, deal_id, status")
    .eq("contract_id", contractId)
    .maybeSingle();

  // Extract metadata.deal_id if present (we set this when we created the contract)
  let metadataDealId: string | null = null;
  try {
    const meta = contractObj?.metadata;
    if (meta) {
      const parsed = typeof meta === "string" ? JSON.parse(meta) : meta;
      metadataDealId = parsed?.deal_id ?? null;
    }
  } catch (_) { /* ignore */ }

  const dealId = existing?.deal_id || metadataDealId;

  // Map event_type → status update + timestamp column
  const now = new Date().toISOString();
  const updates: Record<string, any> = { updated_at: now };
  let activityText: string | null = null;

  switch (eventType) {
    case "contract-sent-to-signer":
      updates.status = "sent";
      updates.sent_at = now;
      activityText = "✉ eSignatures.com contract delivered to signer";
      break;
    case "signer-viewed-the-contract":
      // Only bump to 'viewed' if we're still in 'sent' (don't downgrade later states)
      if (existing?.status === "sent" || existing?.status === "draft") {
        updates.status = "viewed";
      }
      updates.viewed_at = now;
      activityText = "👀 Signer opened the eSignatures.com contract";
      break;
    case "signer-signed":
      if (existing?.status !== "completed") updates.status = "signed";
      updates.signed_at = now;
      activityText = "✍ Signer signed the eSignatures.com contract";
      break;
    case "contract-signed":
      updates.status = "completed";
      updates.completed_at = now;
      if (!existing?.signed_at) updates.signed_at = now;
      activityText = "✅ All signers complete on eSignatures.com contract";
      break;
    case "signer-declined":
      updates.status = "declined";
      activityText = "✗ Signer declined the eSignatures.com contract";
      break;
    case "contract-withdrawn":
      updates.status = "withdrawn";
      updates.withdrawn_at = now;
      activityText = "↩ eSignatures.com contract was withdrawn";
      break;
    case "error":
      updates.status = "error";
      updates.esig_api_error = contractObj?.error_message || contractObj?.message || "unknown error";
      activityText = `⚠ eSignatures.com reported an error: ${updates.esig_api_error}`;
      break;
    // Pass-through for signer-mobile-update-request, sms-incoming,
    // contract-reminder-sent-to-signer — don't change status, just log.
    case "signer-mobile-update-request":
      activityText = "📱 Signer requested mobile update on eSignatures.com contract";
      break;
    case "sms-incoming":
      activityText = "📨 SMS reply received via eSignatures.com gateway";
      break;
    case "contract-reminder-sent-to-signer":
      activityText = "⏰ Reminder sent to signer";
      break;
    default:
      console.warn("[esignatures-webhook] unknown event_type:", eventType);
  }

  if (existing) {
    const { error: upErr } = await sb
      .from("esignatures_contracts")
      .update(updates)
      .eq("id", existing.id);
    if (upErr) console.error("[esignatures-webhook] update failed:", upErr.message);
  } else if (dealId) {
    // Insert a stub row so the dashboard can show it even though we didn't
    // originate the contract. Best-effort.
    const { error: insErr } = await sb.from("esignatures_contracts").insert({
      deal_id: dealId,
      contract_id: contractId,
      status: updates.status || "sent",
      sent_at: updates.sent_at || now,
      viewed_at: updates.viewed_at || null,
      signed_at: updates.signed_at || null,
      completed_at: updates.completed_at || null,
      withdrawn_at: updates.withdrawn_at || null,
    });
    if (insErr) console.error("[esignatures-webhook] stub insert failed:", insErr.message);
  } else {
    console.warn("[esignatures-webhook] no row + no deal_id metadata — cannot persist:", contractId);
  }

  // Best-effort activity row for audit feed
  if (activityText && dealId) {
    try {
      await sb.rpc("log_deal_activity", {
        p_deal_id: dealId,
        p_type: "esignature",
        p_outcome: eventType,
        p_body: activityText,
      });
    } catch (_) { /* best-effort */ }
  }

  // Always 200 — vendor will retry on non-2xx, which causes duplicate events.
  return json({ ok: true, event_type: eventType, contract_id: contractId });
});
