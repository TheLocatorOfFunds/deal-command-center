Looking at this transcript, this was a **substantial session with major security learnings and decisions**. Definitely not trivial. Writing the archive entry:

---
# Session 2026-04-26 — Vercel UI deploy + middleware auth gate

**Owner:** Nathan
**Source JSONL:** <source>
**Status:** DRAFT (auto-generated backfill, needs review)

## What we set out to do
Deploy Phase 7b+7c (person detail page + dashboard) to Vercel production. Run parallel-run validation (T+19h). Defer Mac→VPS cutover to T+24h per timing guard.

## Decisions made (durable — these change behavior going forward)
- **Vercel team upgraded to Pro** ($20/mo) — required for ToS compliance on commercial projects; bandwidth/build headroom bonus. NOT for SSO (Advanced Protection $150/mo was rejected).
- **App-level password gate via middleware** — `web/middleware.ts` + `web/app/login/page.tsx` gate all routes. Password stored in `INTERNAL_UI_PASSWORD` env var (Vercel Production+Preview + local `.env.local`). HttpOnly+Secure+SameSite=Lax cookie, 30-day max-age. Sidestepped $150/mo Advanced Protection add-on.
- **Cutover deferred to T+24h** — parallel run validated clean (361 runs, 348 success, 13 upstream Franklin flakes, 5 agents, 4 county-specific agents 292/292 clean), but timing guard enforced <24h window. Did NOT unload Mac launchd plists this session.

## Gotchas hit (non-obvious; future sessions need to know)
- **Vercel Hobby SSO doesn't protect production aliases** — `ssoProtection.deploymentType` on Hobby max = `all_except_custom_domains`, which covers random deployment URLs like `ohio-intel-abc123.vercel.app` but leaves `ohio-intel.vercel.app` (the friendly alias) publicly accessible. Prior session's "confirmed in incognito" was wrong (cached SSO cookie). Site exposed case data + phones/emails for ~19h before middleware gate deployed.
- **Vercel Pro doesn't fix alias protection either** — "All Deployments" SSO scope requires Pro + Advanced Deployment Protection add-on ($150/mo on top of $20/mo Pro). Password Protection also gated behind same add-on. API rejects `deploymentType=all` with `not available on your plan` even after Pro upgrade.
- **`scrape_runs` table lives in DCC schema** — `intel_client()` failed; had to switch to `dcc_client()`. Table still has no `host` column to partition Mac-vs-VPS writes; can only see distinct `agent_id` values.

## Files / systems touched
- **Repo files:** `web/middleware.ts` (new), `web/app/login/page.tsx` (new), `web/.env.local` (INTERNAL_UI_PASSWORD added), `STATUS.md` (exposure banner removed, Phase 7-protection marked complete), `DECISIONS_LOG.md` (2 entries: Pro upgrade + middleware gate + cutover deferred), `NEXT_PROMPT.md` (rewritten for cutover-only task)
- **DB migrations:** none
- **Edge functions deployed:** none (Next.js app routes only)
- **External systems:** Vercel team billing (Hobby→Pro $20/mo), Vercel env vars (`INTERNAL_UI_PASSWORD` added to Production+Preview via API after CLI flaked on Preview), 2 prod deploys (`dpl_92DvLVBZJm8gxbkKqzPFQ4NdBEoi` Phase 7b+7c, `dpl_rAmTkQYjX6h7EQEGxqfZgzNhZzne` middleware gate)

## Open follow-ups
- [ ] Share password (`-9mkDlT4TW_NT_8uGXsJqNdT2i9R01jd`) with Justin via secure channel
- [ ] Resume Mac→VPS cutover after T+24h (≥00:13 EDT 2026-04-27) via `NEXT_PROMPT.md`
- [ ] Rotate leaked `INTEL_SUPABASE_SERVICE_KEY` (pasted in earlier chat transcript, propagates to 5 places)
- [ ] Merge PR #9 (Phase 7a+7b+7c bundle against main) when ready
---