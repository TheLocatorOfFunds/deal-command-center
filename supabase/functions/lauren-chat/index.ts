import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
const SYSTEM = `You are Lauren, the AI assistant for RefundLocators — an Ohio foreclosure surplus fund recovery company.

CRITICAL FORMATTING RULES — follow these without exception:
- Never use markdown. No asterisks, no bold, no bullet points, no dashes for lists, no headers.
- Keep responses short. 2-4 sentences max unless you are sharing confirmed case details.
- Ask ONE question at a time. Never ask multiple questions in one message.
- Write like a warm, caring human texting someone — not a form, not a brochure.

Your personality:
- Empathetic and genuine. People reaching out are often stressed, confused, or grieving a home.
- Direct and honest. Never oversell or hype.
- You are not an attorney. RefundLocators is not a law firm or a government agency.
- If asked if you're an AI, say yes — use this line: "I'm an AI — Nathan built me to know every case. I escalate to him anytime it gets complicated."

What RefundLocators does:
When a home is sold at a foreclosure auction for more than what was owed, the extra money (the surplus) legally belongs to the former homeowner. Most people never know it exists. RefundLocators finds these cases from public court records, contacts homeowners, and files claims on a 25% to 30% contingency — zero upfront, zero risk. Attorney partner files within 7 business days of signing. Average Ohio surplus is $20,000 to $80,000.

Nathan's origin story — use verbatim when someone questions your legitimacy:
"This happened to me. This is why I know this, because I owned a home. I went into foreclosure. I lost my home. And nobody — like what I do existed. And nobody came to me and explained anything. Nobody tried to help me. And so after I went through that process, I learned it, and now my life's mission is to help people get access to that money."

We don't want to take anything — use when client seems exhausted or suspicious:
"I'm not here to take anything from you. You already lost the house — we're only trying to help you recover the money the county is holding. That's it. Nothing else changes."

Service framing — use when asked what we do:
"Our goal is to bring awareness and understanding to the foreclosure process, then provide solutions. For clients who want to recover surplus funds, we front the attorney cost, the court fees, and do the work. Some clients just need counseling — we walk them through what happened and their options. Either way, it doesn't cost you anything unless we recover money."

COMPLIANCE RULES — these override everything else:

1. FORBIDDEN PHRASES — never use these:
   - "Claim what's yours" (treats client like a mark)
   - "Act fast" / "Don't wait" / "Limited time" (pressure tactics)
   - "You've been awarded" (fake-official language)
   - "Hidden money" / "Unlock" (undignified framing)
   - "Legal notice" (we are not a government body)
   - "Too good to be true" (even in self-reference)
   - Title Case headings, corporate-speak, high-pressure language of any kind

2. DISCLAIMER — cite this any time someone asks about legitimacy or government affiliation:
   "This is not a government service. RefundLocators is a private company. We are not attorneys."
   Never make hard dollar promises — always "estimated," "approximately," "around," or "we think it could be somewhere around."
   If the exact surplus amount isn't confirmed from case records, say: "We'll know the exact amount once the county publishes the confirmation of sale — usually within 30 to 45 days after the auction."

3. OPT-OUT — if the user sends STOP, UNSUBSCRIBE, END, QUIT, or "take me off your list":
   Respond once with: "Understood — you're opted out. You won't hear from us again. If you ever change your mind, we're at refundlocators.com. Take care."
   Then end the conversation. Never argue or persuade.

How to handle conversations:

If someone seems to be in active foreclosure (hasn't happened yet):
- Be compassionate. Acknowledge what they're going through.
- Gently clarify that RefundLocators helps after a foreclosure sale, not before.
- Ask if they know whether the sale has already happened.
- Don't lecture them about the process — just one warm, simple question.

If someone may have a surplus (foreclosure already happened):
- Your goal is to look them up and collect their info — but do it naturally, one question at a time.
- Collection order: first name -> property address -> then search DCC -> if not found, search GHL -> if still not found, collect phone, email, county, and whether they prefer text or call -> then create_lead.
- After each piece of info, use it warmly (repeat their name back, acknowledge what they shared).
- Once you have a name and address, always search before asking more questions.

If you find them in the DCC:
- Share their specific case details clearly, no markdown, in plain conversational sentences.
- Mention the surplus amount, attorney, filing status, and what happens next.
- End with one simple open question — is there anything they're wondering about?
- Offer Nathan's number only if they ask for more help: (513) 951-8855.

If you cannot find them anywhere:
- Continue gathering info one question at a time: phone -> email -> county -> text or call preference.
- Then use create_lead to save them.
- Let them know someone from the team will follow up.

USE SEARCH_KNOWLEDGE PROACTIVELY — call it anytime you encounter:
- Questions about fees or costs
- Scam accusations or trust objections
- Probate or deceased homeowner situations
- Competitor mentions
- Government program questions
- Emotional/grief situations
- Someone saying "let me think about it" or "call me back"
- Timeline questions (how long does this take)
- Anyone who seems to want to go away or says stop
- Questions about what RefundLocators does that need more depth
Search before responding to these — the knowledge base has Nathan's exact words for each situation.

Never:
- Ask more than one question per message.
- Use bullet points or numbered lists in your reply to the user.
- Use bold or asterisks.
- Send a wall of text.
- Promise specific dollar amounts you haven't confirmed from records.`;
const TOOLS = [
  {
    name: "search_knowledge",
    description: "Search RefundLocators' knowledge base for guidance on how to handle a specific situation — fee objections, scam pushback, probate, emotional conversations, competitor questions, timeline questions, opt-outs, and more. Call this BEFORE responding to any objection or complex question. Returns Nathan's exact words and approach for each situation.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Topic or situation to look up, e.g. 'fee objection', 'scam accusation', 'probate', 'already have attorney', 'how long does it take'"
        }
      },
      required: [
        "query"
      ]
    }
  },
  {
    name: "search_dcc",
    description: "Search the RefundLocators case management system for a homeowner by name, phone, or property address. Use this first anytime you have a name or address.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Name, phone number, or property address to search for"
        }
      },
      required: [
        "query"
      ]
    }
  },
  {
    name: "search_ghl",
    description: "Search GoHighLevel CRM for a contact by name or phone. Use if search_dcc returns nothing.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Name or phone number"
        }
      },
      required: [
        "query"
      ]
    }
  },
  {
    name: "create_lead",
    description: "Create a new lead in the case system when the person is not found anywhere. Use after collecting name, address, phone, email, county, and contact preference.",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Full name"
        },
        address: {
          type: "string",
          description: "Foreclosed property address"
        },
        phone: {
          type: "string",
          description: "Phone number"
        },
        email: {
          type: "string",
          description: "Email address"
        },
        county: {
          type: "string",
          description: "Ohio county name"
        },
        case_number: {
          type: "string",
          description: "Court case number if known"
        },
        estimated_surplus: {
          type: "number",
          description: "Estimated surplus if known"
        },
        contact_preference: {
          type: "string",
          description: "text or call"
        },
        notes: {
          type: "string",
          description: "Notes from the conversation"
        }
      },
      required: [
        "name"
      ]
    }
  }
];
async function searchKnowledge(query) {
  const db = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
  const q = `%${query}%`;
  // Search across topic, title, and content
  const { data, error } = await db.from("lauren_knowledge").select("topic, title, content").or(`topic.ilike.${q},title.ilike.${q},content.ilike.${q}`).limit(4);
  if (error) return {
    found: false,
    error: error.message
  };
  if (!data || data.length === 0) {
    // Fallback: try splitting query words
    const words = query.split(/\s+/).filter((w)=>w.length > 3);
    if (words.length === 0) return {
      found: false,
      message: "No knowledge entries found"
    };
    const wordQ = `%${words[0]}%`;
    const { data: d2 } = await db.from("lauren_knowledge").select("topic, title, content").or(`topic.ilike.${wordQ},title.ilike.${wordQ},content.ilike.${wordQ}`).limit(4);
    if (!d2 || d2.length === 0) return {
      found: false,
      message: "No knowledge entries found"
    };
    return {
      found: true,
      count: d2.length,
      entries: d2
    };
  }
  return {
    found: true,
    count: data.length,
    entries: data
  };
}
async function textNathan(message) {
  const sid = Deno.env.get("TWILIO_ACCOUNT_SID");
  const token = Deno.env.get("TWILIO_AUTH_TOKEN");
  const from = Deno.env.get("TWILIO_FROM_NUMBER");
  if (!sid || !token || !from) return;
  try {
    await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${btoa(`${sid}:${token}`)}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        To: "+15139518855",
        From: from,
        Body: message
      }).toString()
    });
  } catch (_) {
  // Don't let SMS failure break the response
  }
}
async function searchDCC(query) {
  const db = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
  const q = "%" + query + "%";
  const { data, error } = await db.from("deals").select("id, name, address, status, type, meta, created_at").eq("type", "surplus").or(`name.ilike.${q},address.ilike.${q}`).limit(5);
  if (error) return {
    found: false,
    error: error.message
  };
  if (!data || data.length === 0) return {
    found: false,
    message: "No matching cases found in DCC"
  };
  const cases = data.map((d)=>{
    const m = d.meta || {};
    return {
      id: d.id,
      name: d.name,
      address: d.address,
      status: d.status,
      county: m.county,
      court_case: m.courtCase,
      estimated_surplus: m.estimatedSurplus,
      fee_pct: m.feePct || 25,
      attorney: m.attorney,
      phone: m.homeownerPhone,
      email: m.homeownerEmail,
      filed_at: m.filed_at
    };
  });
  return {
    found: true,
    deal_id: String(data[0].id),
    cases
  };
}
async function searchGHL(query) {
  const token = Deno.env.get("GHL_API_TOKEN");
  if (!token) return {
    found: false,
    message: "GHL not configured — will create lead in DCC instead"
  };
  try {
    const url = `https://services.leadconnectorhq.com/contacts/?query=${encodeURIComponent(query)}&locationId=i5ezMgdIzcilXpR9nP3I`;
    const res = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${token}`,
        "Version": "2021-07-28"
      }
    });
    const json = await res.json();
    const contacts = json.contacts || [];
    if (contacts.length === 0) return {
      found: false,
      message: "No matching contacts in GHL"
    };
    return {
      found: true,
      count: contacts.length,
      contacts: contacts.slice(0, 3)
    };
  } catch (e) {
    return {
      found: false,
      error: String(e)
    };
  }
}
async function createLead(input) {
  const db = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
  const meta = {
    county: input.county || null,
    courtCase: input.case_number || null,
    estimatedSurplus: input.estimated_surplus || null,
    homeownerPhone: input.phone || null,
    homeownerEmail: input.email || null,
    feePct: 25,
    lead_source: "lauren_chat",
    contact_preference: input.contact_preference || null,
    notes: input.notes || null
  };
  const { data, error } = await db.from("deals").insert({
    name: input.name,
    address: input.address || null,
    type: "surplus",
    status: "new-lead",
    meta
  }).select("id, name, status").single();
  if (error) return {
    success: false,
    error: error.message
  };
  // Text Nathan about the new lead
  const parts = [
    `Lauren created a new lead: ${input.name}`,
    input.phone ? `Phone: ${input.phone}` : null,
    input.address ? `Address: ${input.address}` : null,
    input.county ? `County: ${input.county}` : null,
    `DCC: ${data.id}`
  ].filter(Boolean);
  await textNathan(parts.join("\n"));
  return {
    success: true,
    deal_id: String(data.id),
    message: `New lead created for ${input.name}`,
    deal: data
  };
}
async function upsertSession(db, sessionId, dealId, visitorId, messages) {
  if (sessionId) {
    const update = {
      messages,
      updated_at: new Date().toISOString()
    };
    if (dealId) update.deal_id = dealId;
    await db.from("lauren_sessions").update(update).eq("id", sessionId);
    return sessionId;
  }
  const row = {
    session_type: "homeowner",
    messages
  };
  if (dealId) row.deal_id = dealId;
  if (visitorId) row.visitor_id = visitorId;
  const { data } = await db.from("lauren_sessions").insert(row).select("id").single();
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
  let messages, sessionId, dealId, visitorId;
  try {
    const body = await req.json();
    messages = body.messages;
    sessionId = body.session_id || null;
    dealId = body.deal_id || null;
    visitorId = body.visitor_id || null;
    if (!Array.isArray(messages)) throw new Error("messages must be an array");
  } catch (e) {
    return Response.json({
      error: String(e)
    }, {
      status: 400,
      headers: CORS
    });
  }
  const db = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
  let currentMessages = [
    ...messages
  ];
  let finalReply = "";
  let resolvedDealId = dealId;
  for(let i = 0; i < 10; i++){
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
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
    const toolResults = await Promise.all(toolUses.map(async (tu)=>{
      let toolResult;
      if (tu.name === "search_knowledge") {
        toolResult = await searchKnowledge((tu.input || {}).query);
      } else if (tu.name === "search_dcc") {
        toolResult = await searchDCC((tu.input || {}).query);
        if (toolResult.found && toolResult.deal_id && !resolvedDealId) {
          resolvedDealId = toolResult.deal_id;
        }
      } else if (tu.name === "search_ghl") {
        toolResult = await searchGHL((tu.input || {}).query);
      } else if (tu.name === "create_lead") {
        toolResult = await createLead(tu.input || {});
        if (toolResult.success && toolResult.deal_id && !resolvedDealId) {
          resolvedDealId = toolResult.deal_id;
        }
      } else {
        toolResult = {
          error: "Unknown tool"
        };
      }
      return {
        type: "tool_result",
        tool_use_id: tu.id,
        content: JSON.stringify(toolResult)
      };
    }));
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
  // Save full conversation to lauren_sessions
  const allMessages = [
    ...messages,
    {
      role: "assistant",
      content: finalReply
    }
  ];
  const newSessionId = await upsertSession(db, sessionId, resolvedDealId, visitorId, allMessages);
  return Response.json({
    reply: finalReply,
    session_id: newSessionId,
    deal_id: resolvedDealId
  }, {
    headers: {
      ...CORS,
      "Content-Type": "application/json"
    }
  });
});

