---
# Session 2026-04-20 — Lauren AI rebuild + knowledge base load

**Owner:** Nathan
**Source JSONL:** <source>
**Status:** DRAFT (auto-generated backfill, needs review)

## What we set out to do
Initially: prep for 3pm meeting with Cristian to transition away from his N8N/Lauren build. Shifted mid-session when Nathan decided to let Cristian finish his rebuild (as a reference spec), but take full ownership of the real build in parallel. Final goal: mine transcripts, write Lauren's system prompt, and load the knowledge base into Supabase.

## Decisions made (durable — these change behavior going forward)
- **Cristian's N8N rebuild happens on our Supabase** — we treat it as a blueprint, not the production system
- **Knowledge base lives in DCC Supabase project** (`rcfaashkfpurkvtmsmeb`) — two new tables: `lauren_knowledge` (57 rows loaded), `lauren_conversations` (ready)
- **Fee is 25–30%, not flat 25%** — Nathan's own words from transcripts, update all client-facing copy
- **"Understanding" beats "guidance"** — Nathan explicitly prefers this word, embed it everywhere
- **Lauren is case-aware at chat start** — she opens already knowing your case (GHL data injected via template variables)
- **Output defaults to brevity** — Claude will keep replies under 300 words unless instructed otherwise, to preserve token budget

## Gotchas hit (non-obvious; future sessions need to know)
- **Cristian's prior Supabase project was deleted** — that's why Lauren stopped working, not a design flaw. Call recordings may have been lost. Recovery path: find originals in Granola/Zoom/GHL.
- **2025 Surplus Conversations.txt is JSON-structured** — 3,226 call entries, not plaintext. Needs `ast.literal_eval()` on `speaker_labels` field before mining.
- **Sept–Oct transcripts are 5/7 Defender HA deals, not RefundLocators** — still useful for voice patterns, but not surplus-specific.
- **Anthropic API key in refundlocators-pipeline .env is declared but empty** — real key lives in Supabase Edge Function secrets (not in local env files).
- **Claude Max 20× isn't self-service** — Nathan is on Max 5×, no higher tier visible in claude.ai Settings → Plan. Alternative: API billing with monthly cap.

## Files / systems touched
- **Repo files:**
  - None (all work products saved to `/Users/alexanderthegreat/Documents/Claude/` local dir, not pushed to GitHub)
- **Local documents created:**
  - `lauren-rebuild-meeting-notes.md` — 3pm prep script
  - `lauren-rebuild-from-scratch.md` — clean-slate architecture doc
  - `lauren-voice-guide.md` — 20 patterns mined from 274 substantive Nathan calls
  - `lauren-system-prompt-v1.md` — production-ready prompt with 16 template variables
  - `lauren-test-harness.py` — 5-scenario API test script (requires ANTHROPIC_API_KEY to run)
  - `LAUREN_PROJECT_HANDOFF.md` — comprehensive handoff doc (6K words, 14-phase roadmap)
- **DB migrations:**
  - `enable_pgvector_and_create_lauren_tables` applied to Supabase project `rcfaashkfpurkvtmsmeb`
  - Tables created: `public.lauren_knowledge`, `public.lauren_conversations`
  - Function created: `public.lauren_search_knowledge()` (semantic search, requires embeddings to be added)
- **Data loaded:**
  - 57 rows inserted into `lauren_knowledge` (20 voice patterns, 23 objection responses, 6 call summaries, 5 compliance rules, 3 opener templates)
- **Edge functions deployed:** None
- **External systems:**
  - Supabase project `rcfaashkfpurkvtmsmeb` — pgvector extension enabled, schema applied, data loaded

## Open follow-ups
- [ ] Confirm Anthropic API key location (Supabase secrets or elsewhere) and add to test harness
- [ ] Recover original call recordings (Granola/Zoom/GHL) if Cristian's deleted Supabase held them
- [ ] Decide: contact Anthropic support for Max 20× upgrade, or switch to API billing with monthly cap
- [ ] Add embeddings to `lauren_knowledge` table (requires OpenAI or Voyage API key + ingest script)
- [ ] Mine May–June + July–Aug transcripts if additional voice patterns needed
- [ ] Build Cloudflare Worker / Supabase Edge Function for GHL proxy (blocks `case.html` real data)
- [ ] Wire `CONFIG.CASTLE_API_BASE` in index.html + case.html once proxy is live
- [ ] Test Lauren v1 system prompt with real API calls (5-scenario harness ready to run)