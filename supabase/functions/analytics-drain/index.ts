import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Optional secret: set DRAIN_SECRET in Supabase Edge Function secrets to lock the endpoint.
// Configure Vercel drain URL as: .../analytics-drain?secret=<your-secret>
const DRAIN_SECRET = Deno.env.get("DRAIN_SECRET") ?? "";


// CORS: the site beacons from the browser. Scoped to the two site origins
// (never *) so only refundlocators.com pages can deliver events. Added
// 2026-09-19: without these headers every preflighted beacon since launch
// failed silently and all pageview history reads zero. The Web session's
// text/plain workaround keeps working; proper JSON beacons now do too.
const ALLOWED_ORIGINS = new Set([
  "https://refundlocators.com",
  "https://www.refundlocators.com",
]);
function cors(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  if (!ALLOWED_ORIGINS.has(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Max-Age": "86400",
  };
}

Deno.serve(async (req: Request) => {
  const corsHeaders = cors(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
  }

  // Validate shared secret if configured
  if (DRAIN_SECRET) {
    const url = new URL(req.url);
    const secret = url.searchParams.get("secret");
    if (secret !== DRAIN_SECRET) {
      console.warn("analytics-drain: unauthorized request");
      return new Response("Unauthorized", { status: 401, headers: corsHeaders });
    }
  }

  let events: Record<string, unknown>[];
  try {
    const body = await req.text();
    if (!body.trim()) {
      return new Response("OK", { status: 200, headers: corsHeaders });
    }
    // Vercel sends JSON array or NDJSON
    const trimmed = body.trimStart();
    if (trimmed.startsWith("[")) {
      events = JSON.parse(trimmed);
    } else {
      events = trimmed
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    }
  } catch (e) {
    console.error("analytics-drain: parse error", e);
    return new Response("Bad Request", { status: 400, headers: corsHeaders });
  }

  if (!events.length) {
    return new Response("OK", { status: 200, headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const rows = events.map((e) => ({
    event_type:  (e.eventType  as string) ?? "pageview",
    ts:          e.timestamp   ? new Date(e.timestamp as number).toISOString() : null,
    path:        (e.path       as string) ?? null,
    referrer:    (e.referrer   as string) ?? null,
    country:     (e.country    as string) ?? null,
    city:        (e.city       as string) ?? null,
    region:      (e.region     as string) ?? null,
    device_type: (e.deviceType as string) ?? null,
    os_name:     (e.osName     as string) ?? null,
    browser:     (e.clientName as string) ?? null,
    session_id:  (e.sessionId  as string) ?? null,
    project_id:  (e.projectId  as string) ?? null,
    raw:         e,
  }));

  const { error } = await supabase.from("analytics_events").insert(rows);
  if (error) {
    console.error("analytics-drain: insert error", error.message);
    return new Response("Internal Server Error", { status: 500 });
  }

  console.log(`analytics-drain: stored ${rows.length} event(s)`);
  return new Response("OK", { status: 200, headers: corsHeaders });
});
