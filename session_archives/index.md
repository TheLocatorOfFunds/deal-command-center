# Session Archives — Index

One line per archived session, **most recent first**. Skim this when
opening a fresh Claude Code session to know what's been figured out.
Click into any entry for the full record.

Format: `YYYY-MM-DD` · *Owner* · `branch / PR` · short summary.

## 2026

| Date | Owner | Branch / PRs | Summary |
|---|---|---|---|
| **2026-05-01** | Justin | PR #32 | Texting stack post-Quo-port: Tahoe broke Mac→iPhone SMS relay, Spectrum SIM deactivated by port — Option B (add iOS device w/ prepaid SIM for Android SMS) is the path. Session-archives backfill stood up + ran on 13 historical sessions. → [archive](./2026-05-01-texting-stack-quo-port-session-archive-backfill-95913140.md) |
| **2026-04-30** | Justin | docs/* / PRs #21,#23-#28 | A2P 10DLC + Quo + iMessage architecture decided. Mac bridge stays primary SMS (blue bubbles, no opt-out). Twilio Brand parked. Quo voice-only. GHL/HighLevel transfer dropped. → [archive](./2026-04-30-a2p-quo-imessage-architecture.md) |
| **2026-04-29** | Justin | — | FB group posting workflow for flip-2533. Pre-post protocol: in-group duplicate search + /about rule check; pause for human judgment when group rules are ambiguous. → [archive](./2026-04-29-fb-group-post-workflow-for-flip-2533-5e1c55b9.md) |
| **2026-04-23** | Justin | — | 2533 County Road 102 (Eureka Springs) FB marketing assets — 6 hero tiles + 10 property photos prepped for FB REI groups. Output at `~/Desktop/2533_FB_Post/`. → [archive](./2026-04-23-2533-county-road-102-eureka-springs-fb-marketing-e5fe1bb2.md) |
| **2026-04-17** | Justin | (Twilio Trust Hub) | A2P 10DLC SMS campaign registration on Twilio (Customer Care, $10/mo). Comms architecture finalized: iMessage via Mac bridge / Android via Twilio from +1 513-951-8855 / browser calling via Twilio Voice SDK. → [archive](./2026-04-17-twilio-a2p-10dlc-sms-campaign-registration-ca793fe6.md) |

---

## How to add a new entry

1. Write `YYYY-MM-DD-<slug>.md` in this directory using the template
   at `_TEMPLATE.md`.
2. Add a row to the table above (newest at the top).
3. Commit + push so other sessions see it on their next `git pull`.
