## What changed
<!-- 2-4 sentences. What feature/fix is this? What does it do that didn't work before? -->


## Why
<!-- Business reason or bug context. Future sessions need this to understand intent. -->


## Files touched
<!-- List key files so the next Claude session knows where to look -->
- 

## DB changes
<!-- Migrations run? New tables/columns? RLS changes? Write "None" if clean. -->
- [ ] None
- [ ] New table / column (describe below)
- [ ] RLS policy change
- [ ] Edge function deployed

Details:

## How to test
<!-- Steps to manually verify this works. Be specific enough that Nathan or Justin can follow. -->
1. 

## Sessions to notify
<!-- Which Claude sessions are affected? Update WORKING_ON.md after merge. -->
- [ ] Justin's session
- [ ] Nathan's session
- [ ] Mac Mini bridge needs restart (`ssh defender-mini "launchctl unload ~/Library/LaunchAgents/com.refundlocators.bridge.plist && launchctl load ~/Library/LaunchAgents/com.refundlocators.bridge.plist"`)

## Context for future sessions
<!-- Anything a cold Claude session would need to know to continue this work or debug it. 
     Architectural decisions, tradeoffs made, things tried that didn't work. -->

