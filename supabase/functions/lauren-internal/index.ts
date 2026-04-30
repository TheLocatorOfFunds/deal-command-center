import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
const SYSTEM = [
  "You are Lauren, the internal AI assistant for FundLocators LLC.",
  "",
  "You are talking to Nathan or a team member — not a homeowner. Be direct, concise, and fast.",
  "No disclaimers. No handholding. Just answers.",
  "",
  "What you have access to:",
  "- All deals in the DCC (flips + surplus fund cases)",
  "- All documents and their extracted data (engagement agreements, court orders, sheriff sale confirmations, etc.)",
  "- Docket events (court timeline for each case)",
  "- Deal notes",
  "- Tasks",
  "- Contacts",
  "",
  "How to respond:",
  "- Short answers unless detail is explicitly needed",
  "- Use numbers and specifics — never vague",
  "- When searching, always try broad first, narrow if needed",
  "- If asked to summarize a case, pull deal + documents + docket events and give a tight summary",
  "- Format dollar amounts with $ and commas",
  "- Dates as Month D, YYYY",
  "",
  "Status values in the system:",
  "- new-lead: just entered, not yet contacted",
  "- contacted: reached out, no response yet",
  "- signed: engagement agreement signed",
  "- filed: claim filed with court",
  "- disbursement_ordered: court ordered payment — this is the bell-ringer",
  "- recovered: money received",
  "- dead: not pursuing",
  "- on-hold: paused",
  "",
  "Deal types: 'surplus' = foreclosure surplus fund case, 'flip' = real estate flip",
  "",
  "Always search before saying something isn't in the system."
].join("\n");
const TOOLS = [
  {
    name: "search_deals",
    description: "Search deals by name, address, county, or any text. Use for finding a specific person or property. Searches across name and address fields.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Name, address, or any search term"
        },
        type: {
          type: "string",
          description: "Filter by deal type: 'surplus' or 'flip'. Omit for all."
        },
        status: {
          type: "string",
          description: "Filter by status. Omit for all."
        }
      },
      required: [
        "query"
      ]
    }
  },
  {
    name: "list_deals",
    description: "List deals with filters. Use for 'show me all Franklin County cases' or 'how many deals are filed' type questions.",
    input_schema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          description: "'surplus' or 'flip'"
        },
        status: {
          type: "string",
          description: "Status filter"
        },
        county: {
          type: "string",
          description: "County name (searched in meta.county)"
        },
        limit: {
          type: "number",
          description: "Max results, default 20"
        }
      }
    }
  },
  {
    name: "get_deal",
    description: "Get full details for a specific deal by ID, including meta fields. Use after finding a deal with search_deals.",
    input_schema: {
      type: "object",
      properties: {
        deal_id: {
          type: "string",
          description: "The deal ID"
        }
      },
      required: [
        "deal_id"
      ]
    }
  },
  {
    name: "get_deal_documents",
    description: "Get documents uploaded to a deal, including their extracted data (amounts, dates, parties, case numbers).",
    input_schema: {
      type: "object",
      properties: {
        deal_id: {
          type: "string",
          description: "The deal ID"
        }
      },
      required: [
        "deal_id"
      ]
    }
  },
  {
    name: "get_docket_events",
    description: "Get court docket timeline for a deal.",
    input_schema: {
      type: "object",
      properties: {
        deal_id: {
          type: "string",
          description: "The deal ID"
        }
      },
      required: [
        "deal_id"
      ]
    }
  },
  {
    name: "get_deal_notes",
    description: "Get notes logged on a deal.",
    input_schema: {
      type: "object",
      properties: {
        deal_id: {
          type: "string",
          description: "The deal ID"
        }
      },
      required: [
        "deal_id"
      ]
    }
  },
  {
    name: "get_tasks",
    description: "Get tasks, optionally filtered by deal or status.",
    input_schema: {
      type: "object",
      properties: {
        deal_id: {
          type: "string",
          description: "Filter to a specific deal. Omit for all."
        },
        status: {
          type: "string",
          description: "Filter by status"
        }
      }
    }
  },
  {
    name: "summarize_portfolio",
    description: "Get portfolio-level stats: deal counts by status and type, total surplus, pipeline value.",
    input_schema: {
      type: "object",
      properties: {}
    }
  }
];
function sb() {
  return createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
}
async function searchDeals(query, type, status) {
  const db = sb();
  const q = `%${query}%`;
  let req = db.from("deals").select("id,name,address,type,status,meta,created_at").or(`name.ilike.${q},address.ilike.${q}`);
  if (type) req = req.eq("type", type);
  if (status) req = req.eq("status", status);
  const { data, error } = await req.limit(10);
  if (error) return {
    error: error.message
  };
  if (!data?.length) return {
    found: false,
    message: "No deals matched that search"
  };
  return {
    found: true,
    count: data.length,
    deals: data.map(formatDeal)
  };
}
async function listDeals(type, status, county, limit = 20) {
  const db = sb();
  let req = db.from("deals").select("id,name,address,type,status,meta,created_at");
  if (type) req = req.eq("type", type);
  if (status) req = req.eq("status", status);
  req = req.order("created_at", {
    ascending: false
  }).limit(limit);
  const { data, error } = await req;
  if (error) return {
    error: error.message
  };
  let results = data || [];
  if (county) {
    const c = county.toLowerCase();
    results = results.filter((d)=>{
      const m = d.meta || {};
      return String(m.county || "").toLowerCase().includes(c);
    });
  }
  return {
    count: results.length,
    deals: results.map(formatDeal)
  };
}
async function getDeal(dealId) {
  const db = sb();
  const { data, error } = await db.from("deals").select("*").eq("id", dealId).single();
  if (error || !data) return {
    error: "Deal not found"
  };
  return {
    deal: data
  };
}
async function getDealDocuments(dealId) {
  const db = sb();
  const { data, error } = await db.from("documents").select("id,name,path,size,extraction_status,extracted,extracted_at,created_at").eq("deal_id", dealId).order("created_at", {
    ascending: false
  });
  if (error) return {
    error: error.message
  };
  return {
    count: data?.length || 0,
    documents: data || []
  };
}
async function getDocketEvents(dealId) {
  const db = sb();
  const { data, error } = await db.from("docket_events").select("*").eq("deal_id", dealId).order("event_date", {
    ascending: true
  });
  if (error) return {
    error: error.message
  };
  return {
    count: data?.length || 0,
    events: data || []
  };
}
async function getDealNotes(dealId) {
  const db = sb();
  const { data, error } = await db.from("deal_notes").select("*").eq("deal_id", dealId).order("created_at", {
    ascending: false
  });
  if (error) return {
    error: error.message
  };
  return {
    count: data?.length || 0,
    notes: data || []
  };
}
async function getTasks(dealId, status) {
  const db = sb();
  let req = db.from("tasks").select("*");
  if (dealId) req = req.eq("deal_id", dealId);
  if (status) req = req.eq("status", status);
  const { data, error } = await req.order("created_at", {
    ascending: false
  }).limit(20);
  if (error) return {
    error: error.message
  };
  return {
    count: data?.length || 0,
    tasks: data || []
  };
}
async function summarizePortfolio() {
  const db = sb();
  const { data, error } = await db.from("deals").select("id,type,status,meta");
  if (error) return {
    error: error.message
  };
  const deals = data || [];
  const surplus = deals.filter((d)=>d.type === "surplus");
  const flips = deals.filter((d)=>d.type === "flip");
  const byStatus = (arr)=>arr.reduce((acc, d)=>{
      acc[d.status] = (acc[d.status] || 0) + 1;
      return acc;
    }, {});
  const totalSurplus = surplus.reduce((sum, d)=>{
    const m = d.meta || {};
    return sum + (Number(m.estimatedSurplus) || 0);
  }, 0);
  return {
    total_deals: deals.length,
    surplus_cases: {
      count: surplus.length,
      by_status: byStatus(surplus),
      total_estimated_surplus: totalSurplus
    },
    flips: {
      count: flips.length,
      by_status: byStatus(flips)
    }
  };
}
function formatDeal(d) {
  const m = d.meta || {};
  return {
    id: d.id,
    name: d.name,
    address: d.address,
    type: d.type,
    status: d.status,
    county: m.county,
    court_case: m.courtCase,
    estimated_surplus: m.estimatedSurplus,
    attorney: m.attorney,
    phone: m.homeownerPhone,
    email: m.homeownerEmail,
    filed_at: d.filed_at,
    created_at: d.created_at
  };
}
async function runTool(name, input) {
  if (name === "search_deals") return searchDeals(input.query, input.type, input.status);
  if (name === "list_deals") return listDeals(input.type, input.status, input.county, input.limit || 20);
  if (name === "get_deal") return getDeal(input.deal_id);
  if (name === "get_deal_documents") return getDealDocuments(input.deal_id);
  if (name === "get_docket_events") return getDocketEvents(input.deal_id);
  if (name === "get_deal_notes") return getDealNotes(input.deal_id);
  if (name === "get_tasks") return getTasks(input.deal_id, input.status);
  if (name === "summarize_portfolio") return summarizePortfolio();
  return {
    error: "Unknown tool"
  };
}
async function saveSession(db, sessionId, messages, sessionType) {
  if (sessionId) {
    await db.from("lauren_sessions").update({
      messages,
      updated_at: new Date().toISOString()
    }).eq("id", sessionId);
    return sessionId;
  }
  const { data } = await db.from("lauren_sessions").insert({
    session_type: sessionType,
    messages
  }).select("id").single();
  return data?.id || crypto.randomUUID();
}
Deno.serve(async (req)=>{
  if (req.method === "OPTIONS") return new Response(null, {
    status: 204,
    headers: CORS
  });
  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!anthropicKey) return Response.json({
    error: "ANTHROPIC_API_KEY not set"
  }, {
    status: 503,
    headers: CORS
  });
  let messages, sessionId;
  try {
    const body = await req.json();
    messages = body.messages;
    sessionId = body.session_id || null;
    if (!Array.isArray(messages)) throw new Error("messages must be array");
  } catch (e) {
    return Response.json({
      error: String(e)
    }, {
      status: 400,
      headers: CORS
    });
  }
  const database = sb();
  let currentMessages = [
    ...messages
  ];
  let finalReply = "";
  for(let i = 0; i < 8; i++){
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 2048,
        system: SYSTEM,
        tools: TOOLS,
        messages: currentMessages
      })
    });
    if (!resp.ok) {
      const txt = await resp.text();
      return Response.json({
        error: `Anthropic ${resp.status}: ${txt.slice(0, 300)}`
      }, {
        status: 500,
        headers: CORS
      });
    }
    const result = await resp.json();
    const toolUses = result.content.filter((b)=>b.type === "tool_use");
    const textBlocks = result.content.filter((b)=>b.type === "text");
    if (result.stop_reason === "end_turn" || toolUses.length === 0) {
      finalReply = textBlocks.map((b)=>b.text || "").join("\n");
      break;
    }
    const toolResults = await Promise.all(toolUses.map(async (tu)=>({
        type: "tool_result",
        tool_use_id: tu.id,
        content: JSON.stringify(await runTool(tu.name, tu.input || {}))
      })));
    currentMessages = [
      ...currentMessages,
      {
        role: "assistant",
        content: result.content
      },
      {
        role: "user",
        content: toolResults
      }
    ];
  }
  // Persist full conversation
  const allMessages = [
    ...messages,
    {
      role: "assistant",
      content: finalReply
    }
  ];
  const newSessionId = await saveSession(database, sessionId, allMessages, "internal");
  return Response.json({
    reply: finalReply,
    session_id: newSessionId
  }, {
    headers: {
      ...CORS,
      "Content-Type": "application/json"
    }
  });
});

