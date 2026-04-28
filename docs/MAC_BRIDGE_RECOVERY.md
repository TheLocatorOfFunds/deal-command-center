# Mac Bridge Recovery — after a power outage

The Defender Mini (192.168.1.12) hosts the iMessage bridge that powers all
outbound DCC SMS. After a power outage, the Mac comes back at a **FileVault
unlock screen** and stays there until someone types the
`dealcommandcenter` password. While it's stuck:

- Outbound texts pile up in `messages_outbound` with `status='pending_mac'`
- SSH key auth is rejected (lock screen banner: "This system is locked…")
- Screen Sharing may or may not be listening

**FileVault is intentionally ON** — see `memory/mac_mini_filevault.md`.
Don't suggest disabling it without an explicit conversation with Justin.

## The fastest recovery path

### 1. Try VNC straight away

From any Mac on the same network:

```
Finder → ⌘K → vnc://192.168.1.12 → Connect
```

If the lock screen appears, log in as `dealcommandcenter`. The bridge
LaunchAgent fires automatically on GUI login; pending messages drain
within ~10 seconds. **Done.**

### 2. If VNC fails ("Connection failed to 192.168.1.12")

Screen Sharing's launchd service didn't bind port 5900 after boot. Re-enable
it over SSH (sshd is usually the only service that comes back cleanly):

```bash
# expect-driven SSH because key auth is blocked at the lock screen.
# Run from a Mac that knows the dealcommandcenter password.
cat > /tmp/ssh-defender-sudo.exp <<'SCRIPT'
#!/usr/bin/expect -f
set timeout 60
set pw [lindex $argv 0]
set cmd [lindex $argv 1]
log_user 0
spawn ssh -4 -tt -o IdentitiesOnly=yes -o PubkeyAuthentication=no \
  -o PreferredAuthentications=password,keyboard-interactive \
  -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -o NumberOfPasswordPrompts=1 \
  dealcommandcenter@defender-mini.local $cmd
expect {
  -re "PWPROMPT_SUDO" { send -- "$pw\r"; log_user 1; exp_continue }
  -re {assword:}      { send -- "$pw\r"; log_user 1; exp_continue }
  "Permission denied" { puts ">>> AUTH_FAIL"; exit 2 }
  timeout             { puts ">>> TIMEOUT";   exit 4 }
  eof
}
SCRIPT
chmod +x /tmp/ssh-defender-sudo.exp

# Kickstart Screen Sharing — pass the password as the first arg
/tmp/ssh-defender-sudo.exp '<dealcommandcenter-password>' \
  'sudo -p PWPROMPT_SUDO -S launchctl kickstart -k system/com.apple.screensharing'

# Then VNC in (step 1)

# Cleanup — don't leave the password helper around
rm -f /tmp/ssh-defender-sudo.exp
```

Verify port 5900 is bound after the kickstart:

```bash
/tmp/ssh-defender-sudo.exp '<password>' \
  'sudo -p PWPROMPT_SUDO -S lsof -iTCP:5900 -sTCP:LISTEN'
```

You should see `launchd ... TCP *:rfb (LISTEN)`.

### 3. After GUI login, sanity-check the bridge

Once you're logged in via VNC, key-based SSH works again:

```bash
ssh defender-mini "
  uptime
  echo '===agent==='
  launchctl list | grep refundlocators
  echo '===messages==='
  pgrep -lf 'Messages.app' || echo 'NOT RUNNING'
  echo '===log==='
  tail -20 /tmp/dcc-bridge.log
"
```

Expect to see:
- `com.refundlocators.bridge` in the launchctl list (PID present, exit 0)
- Messages.app running
- Log lines like `⬆ SENT  +1xxxxxxxxxx  "..."`

### 4. Drain check (optional)

```sql
-- in Supabase SQL editor
select status, count(*), max(created_at)
from messages_outbound
where direction = 'outbound' and from_number = '+15135162306'
group by status;
```

Any leftover `pending_mac` rows should clear within seconds of GUI login.
If they don't, see "Things that have actually broken" below.

## Things that have actually broken

| Symptom | Root cause | Fix |
|---|---|---|
| `pending_mac` rows piling up, Mac is up | GUI not logged in (FileVault) | VNC + type password |
| VNC fails, SSH lock-screen banner | Screen Sharing launchd not bound | step 2 above |
| Bridge log shows AppleScript timeouts | Messages.app crashed or signed out | open Messages.app, verify Nathan's iCloud account is signed in, restart bridge: `launchctl bootout gui/$(id -u)/com.refundlocators.bridge && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.refundlocators.bridge.plist` |
| Stale PID file at `/tmp/dcc-bridge.pid` | Hard kill leftover | bridge handles this on next start ("Stale PID file found … Starting fresh.") — no action needed |
| Multi-number `to_number` like `"614-x-x, 216-x-x, 614-x-x"` | UI accepted comma-separated input | Apple's Messages.app actually parses these as a group iMessage and they go through. Cosmetic, not blocking. |

## Why Auto Login isn't enabled

macOS will not let you set Auto Login while FileVault is on — the disk is
encrypted at boot and a human must enter the password to unlock. FileVault
stays on for security; the trade-off is this manual recovery dance after
outages. A small UPS would shorten the outage window for short power blips
but does not eliminate the issue.

## Reference

- LaunchAgent plist: `~/Library/LaunchAgents/com.refundlocators.bridge.plist`
  (per-user, requires GUI session)
- Bridge source: `mac-bridge/bridge.js` in this repo
- SSH alias: `defender-mini` → `dealcommandcenter@defender-mini.local`,
  key at `~/.ssh/defender_mini`
- Mac IP: `192.168.1.12` (LAN — DHCP, but stable in practice)
