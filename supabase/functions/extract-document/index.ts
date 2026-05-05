import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// CORS — DCC is served from app.refundlocators.com (different origin from
// *.supabase.co) so every response needs these headers and OPTIONS preflight
// must return 204 or the browser aborts before the real POST fires.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { ...corsHeaders, "Content-Type": "application/json", ...(init.headers || {}) },
  });

// Minimal JWT sanity check. Gateway-level verify_jwt is off because this
// project uses ES256 tokens which the Supabase gateway can't validate (same
// reason send-sms and docket-webhook run with --no-verify-jwt). At minimum
// we require an Authorization: Bearer <something> header so anonymous callers
// are rejected; full payload validation happens at the DB layer via RLS on
// the documents table the user is trying to extract.
function requireAuth(req: Request): Response | null {
  const authHeader = req.headers.get("Authorization") || req.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ") || authHeader.length < 20) {
    return json({ error: "Unauthorized: missing or invalid Authorization header" }, { status: 401 });
  }
  return null;
}

const IMAGE_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
};

// Default model — matches what Castle's `utils/llm_processor.py` already uses
// for surplus-event field extraction, so we stay on one model across the
// org for consistent extraction quality. Override via OPENAI_MODEL env var
// if you want gpt-4o-mini (≈30x cheaper, slightly less accurate on dense
// legal text) or a future model.
const DEFAULT_MODEL = "gpt-4o";

const EXTRACTION_PROMPT = `You are analyzing a document uploaded to a surplus fund recovery case management system operated by FundLocators LLC, an Ohio-based company that recovers foreclosure surplus funds for former homeowners.

Determine the document type and extract all key fields as structured JSON.

Return ONLY valid JSON in this exact shape (no markdown fences, no prose before or after):

{
  "document_type": one of the type strings listed below,
  "confidence": "high" | "medium" | "low",
  "fields": { key/value pairs per the guidance below },
  "summary": "A one-sentence plain-English description of what this document is and what it establishes",
  "notes": "Optional: illegibility, missing pages, redactions, anything unusual. null if clean."
}

── DOCUMENT TYPES AND FIELD GUIDANCE ─────────────────────────────────────────

SURPLUS FUND RECOVERY DOCUMENTS (prefer these types when the document fits)

"engagement_agreement"
  A signed contract retaining FundLocators or similar firm to recover surplus funds.
  Fields: client_name, client_address, property_address, county, case_number,
          fee_percentage (number, e.g. 25), surplus_amount_estimated,
          attorney_name, firm_name, signed_date, effective_date, expiration_date

"surplus_distribution_order"
  A court order directing release / distribution of foreclosure surplus funds.
  Fields: case_number, court_name, county, judge_name, order_date,
          property_address, surplus_amount (number), claimant_name,
          claimant_share (number), disbursement_date, attorney_of_record

"sheriff_sale_confirmation"
  A court entry or sheriff's report confirming the foreclosure auction sale.
  Fields: case_number, court_name, county, property_address,
          sale_date, sale_price (number), minimum_bid (number),
          judgment_amount (number), surplus_amount (number),
          purchaser_name, confirmation_date

"notice_of_default"
  An NOD, lis pendens, or initial foreclosure filing.
  Fields: case_number, court_name, county, filing_date,
          defendant_name, plaintiff_name (lender/bank),
          property_address, judgment_amount (number), auction_date

"proof_of_claim"
  A filed claim for surplus funds submitted to the court or county.
  Fields: case_number, court_name, county, filed_date,
          claimant_name, amount_claimed (number), attorney_name,
          supporting_docs_listed

"distribution_check"
  A check or wire confirmation representing disbursement of surplus funds.
  Fields: payee, amount (number), date, check_number,
          issuer, memo, bank_name

GENERAL LEGAL / IDENTITY DOCUMENTS

"death_certificate"
  Fields: decedent_name, dob, dod, place_of_death, county,
          cause_of_death, informant_name, certificate_number, state

"id_document"
  Driver's license, passport, state ID.
  Fields: full_name, dob, id_number, issue_date, expiration_date,
          address, state, id_type

"deed"
  Warranty deed, quit-claim deed, sheriff's deed.
  Fields: grantor, grantee, property_address, recording_date,
          book_page, deed_type, consideration (number), county

"power_of_attorney"
  Fields: grantor, attorney_in_fact, scope, effective_date,
          expiration_date, notarized (boolean)

"probate_document"
  Will, letters testamentary, inventory, final account.
  Fields: decedent_name, case_number, court, county,
          executor_or_administrator, filing_date, document_subtype

"bank_statement"
  Fields: account_holder, institution, account_number_last4,
          statement_period_start, statement_period_end,
          ending_balance (number)

"correspondence"
  Letter, email printout, notice.
  Fields: from, to, subject, date, re_case_number

"court_filing"
  Any court document not covered by a more specific type above.
  Fields: case_number, court_name, county, filing_date,
          filer, document_title, judge_name

"other"
  Anything that doesn't fit above.
  Fields: free-form key/value pairs of every identifying field visible.

── FORMATTING RULES ──────────────────────────────────────────────────────────
- Dates: ISO strings YYYY-MM-DD. Use null if not present or illegible.
- Dollar amounts: plain numbers, no $ or commas (e.g. 47250.00).
- Percentages: plain numbers (e.g. 25 for 25%).
- Booleans: true / false.
- Missing or illegible fields: null (never omit the key if it is in the guidance).
- Output ONLY the JSON object. No commentary, no markdown fences.
`;

// Fetch the file behind a Supabase signed URL and return it as a base64
// data URL. OpenAI's chat completions API accepts:
//   - Images via { type: "image_url", image_url: { url } } — the URL can be
//     either a public URL or a data: URL.
//   - PDFs via { type: "file", file: { filename, file_data } } where
//     file_data is a base64 data URL. PDFs do NOT support being passed by
//     external URL; the bytes have to ship inline.
async function fetchAsDataUrl(signedUrl: string, mimeType: string): Promise<string> {
  const res = await fetch(signedUrl);
  if (!res.ok) throw new Error(`Failed to download document: HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  // Chunked btoa — atob/btoa argument string limit is ~64k on some runtimes.
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < buf.length; i += chunkSize) {
    binary += String.fromCharCode(...buf.subarray(i, i + chunkSize));
  }
  const b64 = btoa(binary);
  return `data:${mimeType};base64,${b64}`;
}

Deno.serve(async (req: Request) => {
  // CORS preflight — must come before any other check
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }

  const authFail = requireAuth(req);
  if (authFail) return authFail;

  const openaiKey = Deno.env.get("OPENAI_API_KEY");
  if (!openaiKey) {
    return json(
      { error: "OPENAI_API_KEY not configured in Supabase Edge Function secrets" },
      { status: 503 }
    );
  }
  const model = Deno.env.get("OPENAI_MODEL") || DEFAULT_MODEL;

  let documentId: string;
  try {
    const body = await req.json();
    documentId = body.documentId;
    if (!documentId) throw new Error("documentId required");
  } catch {
    return json({ error: "Invalid request: needs { documentId } in JSON body" }, { status: 400 });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { data: doc, error: docErr } = await supabase
    .from("documents")
    .select("id, name, path, size")
    .eq("id", documentId)
    .single();

  if (docErr || !doc) {
    return json({ error: "Document not found" }, { status: 404 });
  }

  const ext = (doc.name?.split(".").pop() || "").toLowerCase();
  const isImage = ext in IMAGE_TYPES;
  const isPdf = ext === "pdf";

  if (!isImage && !isPdf) {
    await supabase
      .from("documents")
      .update({
        extraction_status: "skipped",
        extraction_error: `Unsupported file type: .${ext}. Supported: jpg, png, gif, webp, heic, pdf.`,
      })
      .eq("id", documentId);
    return json({ error: `Unsupported file type: .${ext}` }, { status: 415 });
  }

  await supabase.from("documents").update({ extraction_status: "processing" }).eq("id", documentId);

  const { data: urlData, error: urlErr } = await supabase.storage
    .from("deal-docs")
    .createSignedUrl(doc.path, 600);

  if (urlErr || !urlData?.signedUrl) {
    await supabase
      .from("documents")
      .update({
        extraction_status: "failed",
        extraction_error: "Could not create signed URL: " + (urlErr?.message || "unknown"),
      })
      .eq("id", documentId);
    return json({ error: "Storage error" }, { status: 500 });
  }

  // Build the OpenAI content block. Images can use the signed URL directly;
  // PDFs have to ship inline as base64 because OpenAI's `file` content type
  // doesn't support remote URLs.
  let contentBlock: Record<string, unknown>;
  try {
    if (isImage) {
      contentBlock = {
        type: "image_url",
        image_url: { url: urlData.signedUrl, detail: "high" },
      };
    } else {
      const mime = "application/pdf";
      const dataUrl = await fetchAsDataUrl(urlData.signedUrl, mime);
      contentBlock = {
        type: "file",
        file: { filename: doc.name || "document.pdf", file_data: dataUrl },
      };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error preparing content";
    await supabase
      .from("documents")
      .update({ extraction_status: "failed", extraction_error: msg.slice(0, 500) })
      .eq("id", documentId);
    return json({ error: msg }, { status: 500 });
  }

  try {
    const openaiResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        // response_format guarantees parseable JSON. Pairs with the
        // "Return ONLY valid JSON" instruction in the system prompt; even
        // if the model adds prose, OpenAI strips it server-side.
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content: [contentBlock, { type: "text", text: EXTRACTION_PROMPT }],
          },
        ],
      }),
    });

    if (!openaiResp.ok) {
      const errText = await openaiResp.text();
      await supabase
        .from("documents")
        .update({
          extraction_status: "failed",
          extraction_error: `OpenAI API ${openaiResp.status}: ${errText.slice(0, 500)}`,
        })
        .eq("id", documentId);
      return json(
        { error: "OpenAI API error", status: openaiResp.status, detail: errText.slice(0, 500) },
        { status: 500 }
      );
    }

    const result = await openaiResp.json();
    const textContent: string = result.choices?.[0]?.message?.content || "";

    // response_format=json_object means the body is already pure JSON,
    // but defensive cleaning costs nothing.
    const cleaned = textContent
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/, "")
      .trim();

    let extracted: unknown;
    try {
      extracted = JSON.parse(cleaned);
    } catch {
      await supabase
        .from("documents")
        .update({
          extraction_status: "failed",
          extraction_error: "OpenAI response was not valid JSON",
          extracted: { raw: textContent },
        })
        .eq("id", documentId);
      return json(
        { error: "Invalid JSON from OpenAI", raw: textContent },
        { status: 500 }
      );
    }

    await supabase
      .from("documents")
      .update({
        extraction_status: "done",
        extracted,
        extracted_at: new Date().toISOString(),
        extraction_error: null,
      })
      .eq("id", documentId);

    return json({ success: true, extracted, model });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    await supabase
      .from("documents")
      .update({
        extraction_status: "failed",
        extraction_error: msg.slice(0, 500),
      })
      .eq("id", documentId);
    return json({ error: msg }, { status: 500 });
  }
});
