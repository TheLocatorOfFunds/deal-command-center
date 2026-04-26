# docs/archive — historical / superseded docs

These files used to live in the repo root. They were moved here on 2026-04-24 during
a documentation audit because they were one of:

- **Setup runbooks for things now live** (the cron job ran, the trigger was applied,
  the migration was deployed). Useful as forensic record only.
- **Time-capsule strategy docs** from a specific past meeting or sprint.
- **Older versions of docs** that have been replaced by a newer one in the root.
- **Specs that shipped** — kept for "why did we build it this way" archaeology.
- **Castle-side handoffs** that the Castle session has already absorbed.

Nothing here is referenced by any active doc in the root or by the build system.
Read CLAUDE.md, README.md, and WORKING_ON.md for current state.

## Quick map (what's in here, why)

### Setup runbooks (post-deploy)
- `SETUP_NOTIFY_CLAIM_SUBMITTED.md` — claim-submitted notification trigger (live)
- `SETUP_CASTLE_HEALTH_DAILY.md` — castle-health-daily Edge Function + cron (live)
- `SETUP_MORNING_SWEEP.md` — morning-sweep cron job (live)
- `SETUP_ATTACH_DOCKET_PDF.md` — Castle's docket-pdf attachment flow (live)

### Castle handoffs (absorbed)
- `CASTLE_POLLER_DOWN_HAMILTON.md` — Hamilton scraper outage post-mortem
- `CASTLE_COURT_PULL_HANDOFF.md` — court_pull_requests queue spec (shipped)
- `CASTLE_DOCKET_INTEGRATION.md` — docket webhook integration brief (shipped)
- `CASTLE_JOHN_DUNN_PROMPT.md` — Castle's John Dunn case onboarding prompt

### Project status snapshots
- `PROJECT_STATUS_AND_ROADMAP.md` — Apr 21, 2026 snapshot (38KB)
- `ROADMAP.md` — earlier roadmap brainstorm
- `TRANSFER_TO_NEW_CLAUDE_CODE.md` — early session-transfer doc (CLAUDE.md replaced this)
- `ONBOARDING.md` — early onboarding doc (CLAUDE.md replaced this)
- `DCC_RECREATE_SPEC.md` — early "recreate from scratch" spec
- `DCC_AGENT_PROMPT.md` — early agent prompt
- `DCC_TO_INTEL_MAIN_NOTE.md` — note to ohio-intel session
- `COMMAND_CENTER_MERGE_BRIEF.md` — early command-center merge brief

### Justin-side specs (shipped or superseded)
- `JUSTIN_BRIDGE_GROUP_DETECTION_SPEC.md`
- `JUSTIN_LAUREN_CONVERSATIONAL_INTAKE_SPEC.md`
- `JUSTIN_MULTI_CONTACT_SMS_SPEC.md`
- `JUSTIN_FEEDBACK_ON_2WEEK_PLAN.md`
- `JUSTIN_SIDE_INVENTORY.md`

### Older versions
- `DOCUSIGN_SETUP.md` — replaced by `DOCUSIGN_ENGAGEMENT_TEMPLATE_SETUP.md` in root
- `LEAD_FUNNEL_2WEEK_PLAN.md` — superseded by Outreach + Forecast views shipping
- `PHASE_3_LIBRARY_PLAN.md` — Library shipped 2026-04-26
- `README-phase-0.md` — early phase-0 README
- `REVERT_NOTES.md` — reset checkpoint notes (no longer needed)
