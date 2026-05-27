# Session Archives — Index

One line per archived session, **most recent first**. Skim this when
opening a fresh Claude Code session to know what's been figured out.
Click into any entry for the full record.

Format: `YYYY-MM-DD` · *Owner* · `branch / PR` · short summary.

## 2026

| Date | Owner | Branch / PRs | Summary |
|---|---|---|---|
| **2026-05-27** | Nathan | main · #235 #237 | DCC cleanup + Relay/Automations coordination + Director confidence tiers. Shipped #237 (surplus confidence-tier badge+filter from read-only `meta.confidenceTier`), delete-guard (warn on deleting active-recovery deals), Attention→Deadlines. Committed send-split fix (#235, **awaiting Justin EF deploy**). Reversed mistaken Relay retirement; coordinated Phase A with Justin (#233) + labeled Relay rows in the shared queue. Posted Delete-vs-Mark-Dead SOP to #Ops. Gotchas: supabase MCP unauthorized → reconstructed-client workaround; long-session JWT expiry needs refresh+persist; CDP freezes on heavy lists. → [archive](./2026-05-27-dcc-cleanup-relay-coord-confidence.md) |
| **2026-05-12** | Nathan | main | 🚨 **Security incident.** Kemper Ansel got admin role on signup because `handle_new_user`'s fallback was `role='user'` (admin) and his auth.users predated the client_access invite (trigger fired before the row existed). Saw entire DCC for unknown window. Five-layer hardening shipped: role flipped to client, sessions revoked, `handle_new_user` rewritten with explicit team allowlist + `'pending'` default, safety trigger on `client_access` INSERT, DCC URL gate, # Ops alert on role promotion. Audit confirmed no other accidental admins. → [archive](./2026-05-12-kemper-admin-leak.md) |
| **2026-05-08** | Nathan | main · `fix/judgment-drain-oom` (ohio-intel) | Audit + retraction marathon. 8 SQL migrations to prod. Centralized contact→deal-meta drift pattern (hit 4×: phone, deceased, relationship, personalized_links.phone). 3rd notification leg (# Ops chat) for claim submissions + Lauren alerts. Per-view audit table on personalized_links. Engagement strip on every deal. Soft-delete with reason codes. Eric caught 2 of my misclaims — retracted publicly. Castle "chronic" alert was misleading; scrapers healthy, email path is the real broken thing. judgment-drain OOM fixed on branch. → [archive](./2026-05-08-audit-retraction-marathon.md) |
| **2026-05-05** | Nathan | (backfill) | Research agent design Q&A: PropStream/IDI Core via web automation (not API), one-deal/many-claimants fee structure, $0.03/lead target cost, webhook-fired on defender-mini. Resolves 6 of the GAPS-doc blockers. → [archive](./2026-05-05-session-ae5812fb.md) |
| **2026-05-04** | Nathan | (backfill) | Records-request blast: 72 counties enumerated, $2.86M verified surplus ingested + triaged into A/B/C tiers. Castle's surplus pipeline + ohio-intel handoff matured. → [archive](./2026-05-04-records-request-blast-72-counties-286m-verified-su-46189db8.md) |
| **2026-05-01** | Nathan | (backfill) | Outreach pipeline + floating chat bubble + portal polish + research-agent design. Auto-queue Day-0 SMS on Mark Prepped, conversion funnel, name-slug URLs, unified hero card with status-driven copy. → [archive](./2026-05-01-outreach-pipeline-chat-bubble-portal-polish-resear-2d3f48cf.md) |
| **2026-05-01** | Nathan | (backfill) | Surplus pipeline: retry backlog + 88-county records-request survey + OCR rewrite from regex to Claude Vision. → [archive](./2026-05-01-surplus-retry-backlog-survey-ocr-rewrite-2b49f9e3.md) |
| **2026-05-01** | Justin | PR #32 | Texting stack post-Quo-port: Tahoe broke Mac→iPhone SMS relay, Spectrum SIM deactivated by port — Option B (add iOS device w/ prepaid SIM for Android SMS) is the path. Session-archives backfill stood up + ran on 13 historical sessions. → [archive](./2026-05-01-texting-stack-quo-port-session-archive-backfill-95913140.md) |
| **2026-04-30** | Justin | docs/* / PRs #21,#23-#28 | A2P 10DLC + Quo + iMessage architecture decided. Mac bridge stays primary SMS (blue bubbles, no opt-out). Twilio Brand parked. Quo voice-only. GHL/HighLevel transfer dropped. → [archive](./2026-04-30-a2p-quo-imessage-architecture.md) |
| **2026-04-29** | Justin | — | FB group posting workflow for flip-2533. Pre-post protocol: in-group duplicate search + /about rule check; pause for human judgment when group rules are ambiguous. → [archive](./2026-04-29-fb-group-post-workflow-for-flip-2533-5e1c55b9.md) |
| **2026-04-28** | Nathan | (backfill) | DCC Import + Team Messaging + Relationship URLs. Per-contact personalized links (`{owner}-{firstname}` slug pattern), team chat scaffold, lead-import flow. → [archive](./2026-04-28-dcc-import-team-messaging-relationship-urls-42ab7ed6.md) |
| **2026-04-28** | Nathan | (backfill) | BatchData lien lookup + county_clerk scaffold. BatchData uses `dataset:"premium"` payload param to return `openLien.mortgages`. Castle's token in GCP Secret Manager. county_clerk arch is platform-families (CV3 shared) not 1:1 per-county. → [archive](./2026-04-28-session-455fd7da.md) |
| **2026-04-27** | Nathan | (backfill) | Detail-page enrichment pipeline shipped — 86 rows decorated. Realauction DOM selectors locked across 88 OH counties (`<th class="bLab">/<td class="bDat">`). Migration 0007 added 14 grading columns to `ohio_case`. → [archive](./2026-04-27-detail-page-enrichment-pipeline-shipped-86-rows-de-b9076c14.md) |
| **2026-04-27** | Nathan | (backfill) | Native realsheriff scraper + 88-county deploy. → [archive](./2026-04-27-native-realsheriff-scraper-88-county-deploy-2fc263e4.md) |
| **2026-04-27** | Nathan | (backfill) | Realsheriff Step 2: detail-page enrichment 88-county sweep. → [archive](./2026-04-27-realsheriff-step-2-detail-page-enrichment-88-count-709101ba.md) |
| **2026-04-26** | Nathan | (backfill) | Vercel UI deploy + middleware auth gate for ohio-intel dashboard. → [archive](./2026-04-26-vercel-ui-deploy-middleware-auth-gate-2b8572d2.md) |
| **2026-04-23** | Justin | — | 2533 County Road 102 (Eureka Springs) FB marketing assets — 6 hero tiles + 10 property photos prepped for FB REI groups. Output at `~/Desktop/2533_FB_Post/`. → [archive](./2026-04-23-2533-county-road-102-eureka-springs-fb-marketing-e5fe1bb2.md) |
| **2026-04-21** | Nathan | (backfill) | On-demand court-pull poller — Castle ↔ DCC integration shipped. Atomic `claim_court_pull_request` RPC, Butler CV3 + Franklin full PDF support. Verified end-to-end on Casey Jennings (42 docs / 47 extractions / 77 events / 0 failures). → [archive](./2026-04-21-session-595a2b5d.md) |
| **2026-04-20** | Nathan | (backfill) | DCC Phase 2 Contacts/CRM build + Phase 3 Library design notes. → [archive](./2026-04-20-phase-2-contactscrm-build-phase-3-library-notes-51dcc07a.md) |
| **2026-04-20** | Nathan | (backfill) | Lauren AI rebuild + knowledge base load. → [archive](./2026-04-20-lauren-ai-rebuild-knowledge-base-load-ec088cb5.md) |
| **2026-04-20** | Nathan | (backfill) | Castle v2 Phase 1: Butler CV3 reCAPTCHA-v2 calibration, monitor_mode → HMAC webhook path, backfill CLI verified on John Dunn (53 events). → [archive](./2026-04-20-session-9e5e5b2b.md) |
| **2026-04-17** | Justin | (Twilio Trust Hub) | A2P 10DLC SMS campaign registration on Twilio (Customer Care, $10/mo). Comms architecture finalized: iMessage via Mac bridge / Android via Twilio from +1 513-951-8855 / browser calling via Twilio Voice SDK. → [archive](./2026-04-17-twilio-a2p-10dlc-sms-campaign-registration-ca793fe6.md) |

---

## How to add a new entry

1. Write `YYYY-MM-DD-<slug>.md` in this directory using the template
   at `_TEMPLATE.md`.
2. Add a row to the table above (newest at the top).
3. Commit + push so other sessions see it on their next `git pull`.
