import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// intel-sync — pulls docket events from the ohio-intel Supabase project
// into DCC for any DCC deal registered in public.intel_subscriptions.
//
// Cron'd every 30 min by migration 20260428030001_intel_sync_cron.sql.
// Manual invoke: POST with X-Intel-Sync-Secret header (vault: intel_sync_secret).
//
// Env (set in Supabase dashboard → Edge Functions → Secrets):
//   INTEL_SUPABASE_URL              — ohio-intel project URL
//   INTEL_SUPABASE_SERVICE_KEY — ohio-intel service-role key (bypasses RLS)
//   INTEL_SYNC_SECRET               — shared secret for cron + manual calls
//
// Default Supabase secrets (auto-injected, no need to set):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  — DCC project (this one)
//
// Counties currently scraped by ohio-intel (= Castle's CV3_VERIFIED + a few
// others). If a subscription's county isn't in this list we tag it
// county_unbuilt instead of no_match — a future scraper build will flip it
// to matched without manual intervention.
const COVERED_COUNTIES = new Set([
  "Butler", "Cuyahoga", "Franklin", "Montgomery",
]);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-intel-sync-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: any, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST" && req.method !== "GET") return json({ error: "POST or GET only" }, 405);

  // Auth — accept either the shared secret (cron path) or service-role bearer
  // (manual debug path from someone who has dashboard access).
  const sharedSecret = Deno.env.get("INTEL_SYNC_SECRET");
  const headerSecret = req.headers.get("X-Intel-Sync-Secret");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const authHeader = req.headers.get("Authorization") || "";
  const authedViaSecret = !!sharedSecret && headerSecret === sharedSecret;
  const authedViaServiceKey = !!serviceKey && authHeader === `Bearer ${serviceKey}`;
  if (!authedViaSecret && !authedViaServiceKey) {
    return json({ error: "unauthorized" }, 401);
  }

  const dccUrl = Deno.env.get("SUPABASE_URL");
  const dccKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const intelUrl = Deno.env.get("INTEL_SUPABASE_URL");
  const intelKey = Deno.env.get("INTEL_SUPABASE_SERVICE_KEY");
  if (!dccUrl || !dccKey) return json({ error: "DCC supabase env missing" }, 500);
  if (!intelUrl || !intelKey) {
    return json({ error: "INTEL_SUPABASE_URL or INTEL_SUPABASE_SERVICE_KEY not set in EF secrets" }, 500);
  }

  const dcc = createClient(dccUrl, dccKey, { auth: { persistSession: false } });
  const intel = createClient(intelUrl, intelKey, { auth: { persistSession: false } });

  const stats = {
    batch_size: 0,
    matched: 0,
    no_match: 0,
    county_unbuilt: 0,
    events_added: 0,
    errors: 0,
  };

  // Pull pending + matched subscriptions, oldest-first, capped at 100/run so
  // the cron doesn't time out as the catalog grows.
  const { data: subs, error: subErr } = await dcc
    .from("intel_subscriptions")
    .select("deal_id, case_number, county, case_type, intel_case_id, events_synced_count, status")
    .in("status", ["pending", "matched", "error"])
    .order("last_synced_at", { ascending: true, nullsFirst: true })
    .limit(100);
  if (subErr) return json({ error: subErr.message }, 500);

  stats.batch_size = subs?.length || 0;

  for (const sub of subs || []) {
    try {
      // Counties Castle/ohio-intel can't scrape get tagged so the UI can
      // show "scraper not built yet" without making a hopeless lookup.
      if (!COVERED_COUNTIES.has(sub.county)) {
        await dcc.from("intel_subscriptions").update({
          status: "county_unbuilt",
          last_synced_at: new Date().toISOString(),
          last_error: null,
        }).eq("deal_id", sub.deal_id);
        stats.county_unbuilt += 1;
        continue;
      }

      // Resolve ohio_case if we don't already have its id cached
      let intelCaseId = sub.intel_case_id;
      if (!intelCaseId) {
        const { data: cases, error: caseErr } = await intel
          .from("ohio_case")
          .select("id")
          .eq("county", sub.county)
          .eq("case_number", sub.case_number)
          .eq("case_type", sub.case_type || "foreclosure")
          .limit(1);
        if (caseErr) throw new Error(`ohio_case lookup: ${caseErr.message}`);

        if (!cases || cases.length === 0) {
          await dcc.from("intel_subscriptions").update({
            status: "no_match",
            last_synced_at: new Date().toISOString(),
            last_error: null,
          }).eq("deal_id", sub.deal_id);
          stats.no_match += 1;
          continue;
        }
        intelCaseId = cases[0].id;
      }

      // Pull ohio_case metadata for court_system tag (DCC docket_events.court_system)
      const { data: caseRow } = await intel
        .from("ohio_case")
        .select("source_county_system")
        .eq("id", intelCaseId)
        .single();
      const courtSystem = caseRow?.source_county_system || null;

      // Pull all docket events for this case. Could window by discovered_at
      // for efficiency, but volume is low enough that a full pull each time
      // is fine (and keeps the upsert idempotent + crash-safe).
      const { data: events, error: evErr } = await intel
        .from("docket_event")
        .select("id, event_date, event_type, description, raw_text, discovered_at")
        .eq("case_id", intelCaseId);
      if (evErr) throw new Error(`docket_event read: ${evErr.message}`);

      let added = 0;
      for (const e of events || []) {
        const row = {
          deal_id: sub.deal_id,
          external_id: e.id,                        // ohio-intel UUID; never collides with Castle's string ids
          case_number: sub.case_number,
          county: sub.county,
          court_system: courtSystem,
          event_type: e.event_type,
          event_date: e.event_date,
          description: e.description || e.raw_text || null,
          raw: { ohio_intel_event: e },
          source: "ohio_intel",
          detected_at: e.discovered_at || new Date().toISOString(),
          received_at: new Date().toISOString(),
        };
        const { error: upErr, count } = await dcc
          .from("docket_events")
          .upsert(row, { onConflict: "deal_id,external_id", ignoreDuplicates: true, count: "exact" });
        if (upErr) throw new Error(`docket_events upsert: ${upErr.message}`);
        if (count && count > 0) added += 1;
      }

      await dcc.from("intel_subscriptions").update({
        status: "matched",
        intel_case_id: intelCaseId,
        last_synced_at: new Date().toISOString(),
        events_synced_count: (sub.events_synced_count || 0) + added,
        last_error: null,
      }).eq("deal_id", sub.deal_id);

      stats.matched += 1;
      stats.events_added += added;
    } catch (e) {
      stats.errors += 1;
      const message = e instanceof Error ? e.message : String(e);
      await dcc.from("intel_subscriptions").update({
        status: "error",
        last_error: message.slice(0, 300),
        last_synced_at: new Date().toISOString(),
      }).eq("deal_id", sub.deal_id);
      console.error("[intel-sync] sub error", sub.deal_id, message);
    }
  }

  return json({ ok: true, stats });
});
