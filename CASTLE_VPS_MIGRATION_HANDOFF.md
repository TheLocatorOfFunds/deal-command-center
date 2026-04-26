# Castle → VPS migration handoff

**From:** DCC Claude session (Nathan's, on Apr 25 2026)
**To:** Castle Claude session (`~/Documents/Claude/refundlocators-pipeline`)
**Priority:** P1 — production infra is currently a battery-powered laptop.
**Estimated effort:** ~2 hours over a single sitting once VPS is provisioned.

## Why this matters (the motivation in 3 lines)

Castle's 5 launchd jobs run on Nathan's MacBook Pro. Lid-close = court_pull stops polling. OS update = all monitors offline until reboot. Battery dies = silent outage for hours. We saw this in miniature on 2026-04-24 when a brief DNS hiccup at ~7am EDT killed `claim_court_pull_request` calls and the agent silently logged success on every empty drain — DCC eventually flagged it as `red` 13 hours later via the Castle Health Daily agent. Your scrapers are revenue-critical infra; they shouldn't share a power cord with Nathan's daily-driver laptop.

**Goal: get Castle off Nathan's machine and onto an always-on Linux VPS, with zero behavior changes from DCC's perspective.**

## What's moving

| Thing | From | To |
|---|---|---|
| Castle code | `~/Documents/Claude/refundlocators-pipeline` (Mac) | `/opt/castle/refundlocators-pipeline` (VPS, suggested) |
| Python venv | `.venv/` (Python 3.9 on Mac) | `.venv/` (Python 3.12 on Ubuntu 24.04) |
| Cron schedule | 5× `~/Library/LaunchAgents/com.fundlocators.castle-v2.*.plist` | 5× systemd `.timer` + `.service` units |
| Wrapper shims | `/Users/alexanderthegreat/bin/castle-v2-*.sh` | `scripts/cron/*.sh` in the repo (committed) |
| `.env` | `config/.env` on Mac | `config/.env` on VPS (manual transfer; never commit) |
| Logs | `logs/cron/*.log` (per-day, rotated by date in filename) | Same path, plus systemd journal as backup |
| Selenium driver | macOS chromedriver | Linux chromedriver + Chromium |
| 2Captcha / Bright Data / Anthropic / Supabase calls | Outbound HTTPS (host-agnostic) | Same — all are pure API calls, no Mac dependency |

**Nothing changes in:**
- The Castle codebase logic (already cross-platform Python)
- DCC's database schema or webhooks
- The DocketEvent payload to `/docket-webhook`
- Castle Health Daily monitoring (same `scrape_runs` heartbeats, just from a different IP)

## VPS recommendation

**Hetzner CX22** — €3.79/mo (~$4) · 2 vCPU AMD · 4 GB RAM · 40 GB SSD · Ashburn VA datacenter · Ubuntu 24.04 LTS.

Why this size: idle most of the time (5 cron jobs every 30 min, each <1 min wall clock). RAM peaks during Selenium scrapes for butler/cuyahoga/montgomery (~512 MB each). 4 GB gives headroom for two concurrent scrapes + the OS. Disk is plenty for repo + venv + Chromium + 30 days of logs.

Alternatives if Nathan prefers North-American billing: **DigitalOcean Premium AMD 2GB ($14/mo)** has more headroom than Hetzner CX21 but costs ~3.5×. Hetzner is the right call unless billing in EUR is a non-starter.

**Don't recommend AWS / GCP / Azure** for this workload — 3-5× the price for the same compute, and the only reason to pick them would be if Nathan plans to deploy other infra onto the same cloud later. He doesn't.

## Pre-provisioning open question for Nathan

Before provisioning, Nathan should answer:

> **"Castle is becoming intel-main." What's the relationship?**
> - (a) Rename: `castle` repo → `intel-main` repo, prod hostname is `intel-main.fundlocators.com`
> - (b) Wrapper: `intel-main` is a new umbrella project that depends on Castle as a sub-component; Castle stays Castle, hostname is `castle.fundlocators.com` and we add `intel-main` later
> - (c) Greenfield: `intel-main` is unrelated to Castle; Castle just gets a server, hostname `castle.fundlocators.com`

Most likely (b) or (c) given the work I've seen tonight. **Default if Nathan doesn't answer: provision as `castle.fundlocators.com`** — easy to add a CNAME later if intel-main grows on top of it.

## Migration runbook

### Phase 0 — Provision (Nathan, ~10 min)

1. Create Hetzner account at https://hetzner.cloud (or another host).
2. Provision one **CX22** server, Ubuntu 24.04, NA datacenter (Ashburn VA), with Nathan's SSH key pasted in during creation. Generate a fresh keypair just for this box if useful:
   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/castle_vps -C "castle-vps"
   pbcopy < ~/.ssh/castle_vps.pub  # paste into Hetzner SSH key form
   ```
3. Confirm SSH works: `ssh -i ~/.ssh/castle_vps root@<ip>`
4. Hand the IP to whichever Claude session is driving (you, DCC's session, or Nathan does it manually with you guiding).

### Phase 1 — Box setup (~20 min)

```bash
ssh -i ~/.ssh/castle_vps root@<vps-ip>

# Hardening
adduser castle && usermod -aG sudo castle
mkdir -p /home/castle/.ssh
cp /root/.ssh/authorized_keys /home/castle/.ssh/
chown -R castle:castle /home/castle/.ssh
chmod 700 /home/castle/.ssh && chmod 600 /home/castle/.ssh/authorized_keys

# Lock down sshd
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh

# Firewall
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw --force enable

# Install runtime deps
apt update && apt upgrade -y
apt install -y python3.12 python3.12-venv python3-pip git build-essential
apt install -y chromium-browser chromium-chromedriver  # Selenium needs both
apt install -y libnss3 libxss1 libgconf-2-4 libgtk-3-0 fonts-liberation  # Chromium runtime deps

# Verify chromedriver works headless
sudo -u castle chromium-browser --headless --no-sandbox --version
sudo -u castle chromedriver --version
```

Switch to the `castle` user from here. Don't run anything else as root.

### Phase 2 — Install Castle (~15 min)

```bash
ssh -i ~/.ssh/castle_vps castle@<vps-ip>
sudo mkdir -p /opt/castle && sudo chown castle:castle /opt/castle
cd /opt/castle
git clone https://github.com/TheLocatorOfFunds/castle-v2.git refundlocators-pipeline
cd refundlocators-pipeline

python3.12 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt   # or whatever the canonical install path is — check README
```

Then **transfer `.env` from Nathan's Mac to the VPS** (Nathan's hand on this; never paste secrets in chat):

```bash
# From Nathan's Mac:
scp -i ~/.ssh/castle_vps ~/Documents/Claude/refundlocators-pipeline/config/.env castle@<vps-ip>:/opt/castle/refundlocators-pipeline/config/.env
```

**Verify config loads + Supabase reachable:**
```bash
# As castle user on VPS
cd /opt/castle/refundlocators-pipeline
source .venv/bin/activate
AGENT_ID=court_pull python -m utils.court_pull_poller --once --max 1
# Expect: HTTP 200 from claim_court_pull_request, 201 from scrape_runs heartbeat
```

If that 201 lands cleanly, the box is ready. Castle Health Daily will start including the VPS in its agent fleet on the next 13:00 UTC tick.

### Phase 3 — systemd timer conversion (~30 min)

Convert each launchd plist to a systemd `.service` + `.timer` pair. **Reference the existing plists in `~/Library/LaunchAgents/com.fundlocators.castle-v2.*.plist`** for the exact `StartCalendarInterval` minutes per agent.

Suggested file layout (commit to Castle repo under `deploy/systemd/`):

```
deploy/systemd/
  castle-monitor.service           # runs main: hamilton + franklin
  castle-monitor.timer             # :00, :30 every hour
  castle-monitor-butler.service
  castle-monitor-butler.timer      # :00, :30
  castle-monitor-cuyahoga.service
  castle-monitor-cuyahoga.timer    # :10, :40
  castle-monitor-montgomery.service
  castle-monitor-montgomery.timer  # :20, :50
  castle-court-pull.service
  castle-court-pull.timer          # :05, :35
```

Sample `castle-court-pull.service`:
```ini
[Unit]
Description=Castle court_pull queue poller
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=castle
WorkingDirectory=/opt/castle/refundlocators-pipeline
EnvironmentFile=/opt/castle/refundlocators-pipeline/config/.env
Environment="AGENT_ID=court_pull"
ExecStart=/opt/castle/refundlocators-pipeline/.venv/bin/python -m utils.court_pull_poller --once --max 1
StandardOutput=append:/opt/castle/refundlocators-pipeline/logs/cron/court-pull-%Y-%m-%d.log
StandardError=inherit
TimeoutStartSec=10min
```

Sample `castle-court-pull.timer`:
```ini
[Unit]
Description=Castle court_pull poller — :05 and :35

[Timer]
OnCalendar=*-*-* *:05:00
OnCalendar=*-*-* *:35:00
Persistent=true

[Install]
WantedBy=timers.target
```

Install + enable:
```bash
sudo cp deploy/systemd/*.service deploy/systemd/*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now castle-court-pull.timer
sudo systemctl enable --now castle-monitor.timer
sudo systemctl enable --now castle-monitor-butler.timer
sudo systemctl enable --now castle-monitor-cuyahoga.timer
sudo systemctl enable --now castle-monitor-montgomery.timer

# Verify
systemctl list-timers castle-*
```

**Note on Selenium under systemd:** Chromium needs `--no-sandbox` flag when run as a systemd service (no Xorg). Make sure `utils/captcha.py::solve_courtview_gate` and any other Chrome launches include the flag (check `chrome_options.add_argument("--no-sandbox")`). If it's not there, this is the only Linux-specific code change needed.

### Phase 4 — Parallel run + validation (~24 hr)

**Don't disable the Mac launchd jobs yet.** Run both in parallel for 24 hours. Castle Health Daily (in DCC) reads `scrape_runs` and reports each agent's age — both agents will write rows, so the most-recent heartbeat will be from whichever ran last. That's fine.

What to watch:
- Both `scrape_runs` flows write the same agent_id (e.g., both Mac and VPS write `agent_id='court_pull'`). DCC's Castle Health Daily doesn't care WHERE — it just sees fresh heartbeats. Green stays green.
- Watch DCC's `docket_events` for duplicates. They shouldn't dupe — `external_id` has a unique constraint, so the second writer just gets a 23505 violation that the webhook handler treats as a no-op. Confirmed in `supabase/functions/docket-webhook/index.ts` lines 191-196.
- Compare PDF document attachment counts in DCC over the 24h window — if the VPS is doing its job, document/event counts should be roughly equal between the two halves of the day.

After 24h of stable operation, cut over.

### Phase 5 — Decommission Mac (Day 2, ~5 min)

```bash
# On Nathan's Mac
launchctl unload ~/Library/LaunchAgents/com.fundlocators.castle-v2.monitor.plist
launchctl unload ~/Library/LaunchAgents/com.fundlocators.castle-v2.monitor.butler.plist
launchctl unload ~/Library/LaunchAgents/com.fundlocators.castle-v2.monitor.cuyahoga.plist
launchctl unload ~/Library/LaunchAgents/com.fundlocators.castle-v2.monitor.montgomery.plist
launchctl unload ~/Library/LaunchAgents/com.fundlocators.castle-v2.court-pull.plist

# Keep the .plist files for 1 week as DR fallback. Delete after.
```

Verify on the next Castle Health Daily run that all 5 agents stay green. If any goes red within 24h, re-load the corresponding launchd job as fallback while we debug the VPS.

## What Castle's Claude session owns

You (Castle's session) own everything inside this migration except provisioning + the `.env` transfer:

- ✅ Authoring the systemd unit files in `deploy/systemd/` (commit to castle-v2 main)
- ✅ Authoring the wrapper shell scripts under `scripts/cron/` (replace the per-machine ones currently in `/Users/alexanderthegreat/bin/`)
- ✅ Adding `--no-sandbox` Selenium flag if it's not already there for Linux compat
- ✅ Updating `STATUS.md` and `CLAUDE.md` in your repo: prod is now a VPS, repo path is `/opt/castle/refundlocators-pipeline`, scheduler is systemd not launchd, Python is 3.12 not 3.9
- ✅ Writing a 1-page runbook in `docs/VPS_OPS.md`: how to SSH in, how to check status (`systemctl list-timers castle-*`, `journalctl -u castle-monitor.service -n 50`), how to deploy (`git pull && systemctl restart`), how to read logs
- ✅ Driving Phases 1-4 over SSH

## What stays Nathan's responsibility

- Phase 0: VPS provisioning + SSH key setup
- The `.env` file transfer (secrets — you don't see them, you just `EnvironmentFile=` to where they live)
- Decision on hostname / DNS (intel-main.* vs castle.* vs IP-only) — answer the open question above
- The Phase 5 decommission: `launchctl unload` on his Mac after 24h of stable VPS operation

## What DCC's session (me) owns

- Watching `scrape_runs` heartbeats during the parallel-run window
- Confirming Castle Health Daily continues to report green throughout the cutover
- Updating DCC's `CLAUDE.md` to reflect Castle's new prod location
- This handoff doc

## Hard boundaries during the migration

- **Don't change the DocketEvent payload shape.** DCC's webhook expects exactly what Castle currently sends (plus the optional Apr 25 sprint additions). New fields are fine; renamed/removed fields will break the integration.
- **Don't change agent_id values.** DCC's `v_scraper_health` view joins on these. The 5 catalog rows in `scraper_agents` table are: `main`, `butler`, `cuyahoga`, `montgomery`, `court_pull`. Keep them exactly.
- **Don't move the launchd plists or wrapper scripts off Nathan's Mac immediately.** Keep them as DR fallback for at least 1 week post-cutover. Delete only after the VPS has been stable through one full 7-day cycle including a weekend.

## Open questions before you start

These are for Nathan, but I'm collecting them here so they're in one place:

1. **Castle vs intel-main relationship?** (See "Pre-provisioning open question" above.)
2. **VPS host preference?** Default to Hetzner CX22 unless Nathan specifies otherwise.
3. **DNS now or later?** Default to IP-only for v1; add `castle.fundlocators.com` CNAME after stable.
4. **Backup strategy?** The Hetzner instance has snapshots ($0.0119/GB/month). For 40 GB that's $0.50/mo — recommend daily snapshots. Or rely on git + Supabase being the source of truth and treat the VM as cattle.

## Estimated session timeline

- **Day 0 evening (Nathan):** Answer the 4 open questions above. Provision the box. Transfer `.env`.
- **Day 1 morning (Castle session):** SSH in, do Phases 1-3, write systemd units, commit + push to castle-v2/main.
- **Day 1 afternoon → Day 2 morning:** Parallel run (no work, just monitor).
- **Day 2 afternoon (Nathan):** `launchctl unload` on his Mac. Done.
- **Day 9:** Delete the Mac plists.

Total wall-clock: ~2 days, ~2.5 hours of active work split across Nathan + Castle Claude.

---

**Ready to execute when Nathan answers the 4 open questions and hands you a VPS IP.** Reply here with any pushback on the plan, or just start the work and update WORKING_ON.md as you go.
