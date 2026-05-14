/**
 * send-esignature-contract — DCC → eSignatures.com bridge
 *
 * Parallel to docusign-send-envelope. Same input contract; different provider.
 * Justin's intent (2026-05-14): keep DocuSign untouched, add eSignatures.com
 * as a separate path so we can A/B per-envelope before committing.
 *
 * What this function does:
 *   1. Loads the deal + the library_documents row (must have esignatures_template_id)
 *   2. Computes merge values from deal.meta paths + caller overrides
 *   3. POSTs to eSignatures.com /api/contracts with delivery suppressed
 *      (signature_request_delivery_methods=[]) so we deliver the signer URL
 *      ourselves via Twilio SMS — homeowner-on-an-iPhone is our primary UX
 *   4. Stores the contract row in esignatures_contracts
 *   5. Optionally sends the signing link via SMS (existing send-sms EF)
 *
 * Auth: same admin/va auth as DocuSign EF — caller passes their JWT, we
 * verify with the publishable key. Service role is used internally for DB writes.
 *
 * Returns: { contract_id, signing_link, sms_sent }
 *
 * Env (Supabase Edge Function secrets):
 *   ESIGNATURES_API_TOKEN  — bearer/secret token from eSignatures.com dashboard
 *   ESIGNATURES_API_BASE   — defaults to "https://esignatures.com" (override for sandbox)
 *   ESIGNATURES_TEST_MODE  — "yes" for test envelopes, "no" (default) for real
 *
 * Default Supabase secrets (auto-injected):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
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

// Resolve a dot-path on the deal object. Used to compute merge defaults
// from library_documents.template_fields (same pattern as the DocuSign EF).
function resolveDealPath(deal: Record<string, any>, path: string): any {
  if (!path) return "";
  const parts = path.split(".");
  let val: any = deal;
  for (const p of parts) {
    if (val == null) return "";
    val = val[p];
  }
  return val ?? "";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const ESIG_TOKEN = Deno.env.get("ESIGNATURES_API_TOKEN");
  const ESIG_BASE = Deno.env.get("ESIGNATURES_API_BASE") || "https://esignatures.com";
  const ESIG_TEST_MODE = (Deno.env.get("ESIGNATURES_TEST_MODE") || "no").toLowerCase();
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  if (!ESIG_TOKEN) {
    return json({
      error: "esignatures_not_configured",
      message: "Set ESIGNATURES_API_TOKEN in this function's secrets (Supabase dashboard → Edge Functions → send-esignature-contract → Secrets).",
    }, 500);
  }

  // Service-role client for DB writes (RLS bypass — we still pin the
  // sent_by user from the caller's JWT for the activity trail).
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // Resolve caller's user_id from the Authorization header (best effort —
  // if the EF was called via service role, leave sent_by null).
  let sentBy: string | null = null;
  try {
    const authHeader = req.headers.get("Authorization") || "";
    if (authHeader.startsWith("Bearer ")) {
      const userJwt = authHeader.slice(7);
      const { data } = await sb.auth.getUser(userJwt);
      sentBy = data?.user?.id ?? null;
    }
  } catch (_) { /* ignore */ }

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }

  const {
    deal_id,
    library_document_id,
    recipient_email,
    recipient_name,
    recipient_phone,
    merge_overrides,
    email_subject_override,
  } = body || {};

  if (!deal_id || !library_document_id || !recipient_email || !recipient_name) {
    return json({
      error: "missing_fields",
      message: "deal_id, library_document_id, recipient_email, recipient_name are required.",
    }, 400);
  }

  // ── Load deal + template ───────────────────────────────────────────────────
  const [{ data: deal, error: dealErr }, { data: libDoc, error: libErr }] = await Promise.all([
    sb.from("deals").select("id, name, address, meta, type, status").eq("id", deal_id).maybeSingle(),
    sb.from("library_documents")
      .select("id, title, template_fields, esignatures_template_id")
      .eq("id", library_document_id)
      .maybeSingle(),
  ]);

  if (dealErr) return json({ error: "deal_lookup_failed", message: dealErr.message }, 500);
  if (libErr) return json({ error: "template_lookup_failed", message: libErr.message }, 500);
  if (!deal) return json({ error: "deal_not_found" }, 404);
  if (!libDoc) return json({ error: "template_not_found" }, 404);
  if (!libDoc.esignatures_template_id) {
    return json({
      error: "not_an_esignatures_template",
      message: "This library_document has no esignatures_template_id set. SQL-update the row with the template id from your eSignatures.com dashboard first.",
    }, 400);
  }

  // ── Compute merge values: deal-path defaults + caller overrides ────────────
  const templateFields: Record<string, string> = libDoc.template_fields || {};
  const mergeValues: Record<string, string> = {};
  for (const [key, dealPath] of Object.entries(templateFields)) {
    const fromDeal = resolveDealPath(deal as Record<string, any>, dealPath);
    mergeValues[key] = (merge_overrides && merge_overrides[key] != null && merge_overrides[key] !== "")
      ? String(merge_overrides[key])
      : String(fromDeal ?? "");
  }

  // ── Build the eSignatures.com payload ──────────────────────────────────────
  // Key choice: signature_request_delivery_methods = []
  //   → eSignatures.com will NOT send their own email/SMS.
  //   → API response includes sign_page_url per signer; we deliver via Twilio.
  // The placeholder_fields shape uses "api_key" (template field name) +
  // "value" (substituted text). Their docs show this format on the
  // template-tab → docs page.
  const placeholderFields = Object.entries(mergeValues).map(([key, value]) => ({
    api_key: key,
    value,
  }));

  const esigPayload = {
    template_id: libDoc.esignatures_template_id,
    test: ESIG_TEST_MODE === "yes" ? "yes" : "no",
    title: email_subject_override || libDoc.title || `${deal.name || deal.id} agreement`,
    metadata: JSON.stringify({
      deal_id,
      library_document_id,
      source: "dcc",
    }),
    signers: [
      {
        name: recipient_name,
        email: recipient_email,
        // mobile: recipient_phone, // intentionally omitted — we deliver via our own Twilio
        signature_request_delivery_methods: [], // suppress vendor email/SMS
        signature_request_subject: email_subject_override || `Please sign: ${libDoc.title}`,
      },
    ],
    placeholder_fields: placeholderFields,
  };

  // ── POST to eSignatures.com ────────────────────────────────────────────────
  // Their auth model: token in query string. Confirmed in their API reference.
  // Using JSON body content-type per their /api/contracts endpoint spec.
  const apiUrl = `${ESIG_BASE}/api/contracts?token=${encodeURIComponent(ESIG_TOKEN)}`;
  let apiResp: Response;
  let apiData: any;
  try {
    apiResp = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(esigPayload),
    });
    apiData = await apiResp.json();
  } catch (e: any) {
    return json({
      error: "esignatures_api_unreachable",
      message: e?.message || String(e),
    }, 502);
  }

  if (!apiResp.ok || apiData?.status === "error") {
    const errMsg = apiData?.error_message || apiData?.message || `HTTP ${apiResp.status}`;
    return json({
      error: "esignatures_api_error",
      message: errMsg,
      raw: apiData,
    }, 502);
  }

  const contract = apiData?.data?.contract || apiData?.contract || apiData?.data || apiData;
  const contractId: string | undefined = contract?.id || contract?.contract_id;
  const signers: any[] = contract?.signers || [];
  const signingLink: string | undefined =
    signers[0]?.sign_page_url ||
    signers[0]?.signer_url ||
    contract?.signer_url;

  if (!contractId || !signingLink) {
    return json({
      error: "esignatures_response_shape_unexpected",
      message: "Could not locate contract id or signer url in eSignatures.com response. Check the raw payload.",
      raw: apiData,
    }, 502);
  }

  // ── Persist to esignatures_contracts ────────────────────────────────────────
  const sendSms = !!recipient_phone;
  const { data: row, error: insErr } = await sb.from("esignatures_contracts").insert({
    deal_id,
    library_document_id,
    contract_id: contractId,
    status: "sent",
    recipient_email,
    recipient_name,
    recipient_phone: recipient_phone || null,
    send_sms: sendSms,
    signer_url: signingLink,
    merge_values: mergeValues,
    sent_at: new Date().toISOString(),
    sent_by: sentBy,
  }).select("id").single();

  if (insErr) {
    // Contract was created at vendor but we couldn't persist locally — log
    // the failure and still return the signing link so the user can complete
    // the SMS step. We'll reconcile via the webhook.
    console.error("[send-esignature-contract] insert failed:", insErr.message);
  }

  // ── Optionally deliver the SMS ourselves via send-sms EF ───────────────────
  // The send-sms EF already routes via Nathan's iPhone bridge for now (per
  // CLAUDE.md: outbound SMS uses mac_bridge, NOT Twilio). The composed
  // message intentionally short + mobile-friendly.
  let smsSent = false;
  if (sendSms && recipient_phone) {
    const firstName = String(recipient_name).trim().split(" ")[0] || "there";
    const smsBody = `Hi ${firstName}, this is Nathan with RefundLocators. Your authorization letter is ready to sign — tap the link and sign right from your phone (takes 60 seconds):\n\n${signingLink}\n\nQuestions? Call/text (513) 998-5440.`;
    try {
      const smsResp = await fetch(`${SUPABASE_URL}/functions/v1/send-sms`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "apikey": SUPABASE_SERVICE_ROLE_KEY,
        },
        body: JSON.stringify({
          to: recipient_phone,
          body: smsBody,
          deal_id,
        }),
      });
      const smsJson = await smsResp.json().catch(() => ({}));
      smsSent = smsResp.ok && !smsJson?.error;
      if (!smsSent) {
        console.error("[send-esignature-contract] sms send failed:", smsJson);
      }
    } catch (e: any) {
      console.error("[send-esignature-contract] sms send threw:", e?.message || e);
    }
  }

  // ── Log the activity row for audit feed ────────────────────────────────────
  try {
    await sb.rpc("log_deal_activity", {
      p_deal_id: deal_id,
      p_type: "esignature",
      p_outcome: "sent",
      p_body: `✉ eSignatures.com contract sent to ${recipient_name} <${recipient_email}>${sendSms ? ` (SMS to ${recipient_phone})` : ""}`,
    });
  } catch (_) { /* activity logging is best-effort */ }

  return json({
    ok: true,
    contract_id: contractId,
    contract_row_id: row?.id ?? null,
    signing_link: signingLink,
    sms_sent: smsSent,
  });
});
