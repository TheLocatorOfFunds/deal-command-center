# Session 2026-05-12 — Kemper Ansel admin-role leak + five-layer security hardening

**Owner:** Nathan
**Branch(es):** main (DCC) — multiple commits in one session
**Related PRs:** —
**Severity:** 🚨 Critical — client account got full admin role + saw entire DCC for an unknown window before reporting it

## What we set out to do

After a morning of routine bug-fix + portal QA work for John Dunn, Kemper Ansel (a homeowner / claimant we'd invited via DCC's Client Portal card) messaged Nathan: *"I just got a link sent to my email having me sign up for what you believe is your portal. But I now have access to all of your leads."* He'd clicked the magic link Nathan sent and landed in the full DCC admin shell with read access to every deal, every lead, every contact.

Five-layer security hardening session followed: lock Kemper down, audit for others, root-cause the trigger, ship three defenses against recurrence, write this archive.

## Decisions made (durable — these change behavior going forward)

- **`handle_new_user` defaults unmatched emails to `'pending'` (not `'user'`/admin).** The old logic was: if email matches pending client_access → role='client'; else if matches pending attorney_assignments → role='attorney'; **else role='user' (admin)**. The fallback to admin was a default-allow design that exists for the legitimate case of Nathan/Justin/Eric/Inaam signing up for the first time. We replaced it with an explicit email allowlist (`nathan@`, `justin@`, `admin@` = Inaam, `admin3@` = Eric, all @fundlocators.com) and made everything else `'pending'`. Default-deny by default.

- **`tg_client_access_demote_admin_to_client` safety trigger on `client_access` INSERT.** Closes the timing race that bit Kemper: his auth.users row predated Nathan's invite, so when Nathan inserted the client_access row, the `handle_new_user` trigger had already fired (back at his original signup) and granted him admin. Going forward, when client_access is inserted with an email whose auth.users already exists AND profile.role is `('user','admin')`, we demote them to `'client'` and link the row in the same transaction.

- **DCC URL gate.** Even with RLS protecting data, the DCC `index.html` was rendering the admin shell for ANY signed-in user — only the data was empty. After profile loads, if `role` is not in `('admin','user','va')`, we now `window.location.replace('/portal.html')` (or `/attorney-portal.html`) before rendering anything. Defense-in-depth: even if both layers above ever fail, the wrong user never sees the admin chrome.

- **`tg_notify_ops_chat_on_role_change` trigger** posts to # Ops thread whenever any profile.role transitions INTO `('user','admin','va','attorney')`. Same `sender_kind='system'` pattern as the existing claim-submission + Lauren-alert legs. Going forward, if anyone accidentally gets promoted to admin (whether by trigger, manual SQL, or future bug), we see the chat post within a second.

- **`'pending'` is a valid role value.** Verified by test UPDATE: profile.role accepts `'pending'` without violating any CHECK constraint. No RLS policy grants access to `'pending'`, so a pending user has zero data read — they exist in auth.users + profiles but can't see anything. Future flow: pending users get promoted via the Team modal in DCC once Nathan / Eric explicitly OKs them.

- **Investigate-before-changing.** When Kemper reported the leak, the immediate temptation was to revoke his auth user or ban him. Instead the right move (and what we did) was: flip his role to `'client'` (RLS instantly stops the leak), then audit if anyone else has the same problem, then root-cause + fix the trigger, then revoke his refresh tokens. Each step preserved evidence and limited blast radius.

## Gotchas hit (non-obvious; future sessions need to know)

- **`handle_new_user` only fires on auth.users INSERT.** Subsequent magic-link clicks for an existing auth user DO NOT re-run the trigger. So if a client signs up once at any time (test, prior workflow, anything), then is later invited via DCC's Client Portal card, the trigger never re-evaluates — they keep whatever role they got at original signup. This is the architectural reason Kemper's invite didn't auto-fix his role. The safety trigger on `client_access` INSERT closes this race.

- **Email allowlist needs the EXACT addresses.** Nathan's team uses alias accounts (`admin@` = Inaam not Inaam@, `admin3@` = Eric not Eric@). My first pass used logical-name emails (`eric@`, `inaam@`) — got corrected against the actual `auth.users.email` audit. Future: anyone adding a team member should check the audit query before editing the allowlist in `handle_new_user`.

- **Supabase magic links are single-use + ~1hr TTL.** The link Kemper got was already burned. The threat isn't the link itself — it's the **session** in his browser. Killed via `delete from auth.refresh_tokens` + `delete from auth.sessions` for his user_id. Auto-refresh fails within seconds; he gets signed out and re-auth flow restarts (this time he'll land as `'client'`).

- **`profiles.role` has no CHECK constraint** that restricts values — `'pending'`, `'foo'`, anything works. RLS is the actual gate; the role string is opaque to the schema. We verified by running an UPDATE inside a transaction with rollback. If anyone adds a CHECK constraint on profiles.role later, they need to include `'pending'` in the allowlist OR the new handle_new_user breaks all signups for unmatched emails.

- **Activity table is the cleanest source of "what did suspect-user touch."** `select * from activity where user_id = '<id>'` returns 0 rows for Kemper → he didn't act through any standard app flow. The `deals.updated_at` field is noisy (any update by anyone bumps it, not the suspect). Trust activity-from-user-id, treat deals.updated_at as background noise.

## Files / systems touched

- **Repo files (DCC):**
  - `src/app.jsx` — added DCC URL gate after profile load (~line 560). Non-team roles redirect to portal.html / attorney-portal.html before render.
  - `app.js` — rebuilt + committed
  - `session_archives/2026-05-12-kemper-admin-leak.md` — this file
  - `session_archives/index.md` — entry added

- **DB changes applied (no migration file written — these are critical-path security changes that lived in dashboard):**
  - `handle_new_user()` REPLACED — explicit team allowlist + `'pending'` default
  - `tg_client_access_demote_admin_to_client` trigger created on `public.client_access`
  - `notify_ops_chat_on_role_change()` function + `tg_notify_ops_chat_on_role_change` trigger created on `public.profiles`
  - `delete from auth.refresh_tokens where user_id = 'fa53536e-083d-44ae-ab13-023bb1a92548'`
  - `delete from auth.sessions where user_id = 'fa53536e-083d-44ae-ab13-023bb1a92548'`
  - `update profiles set role='client' where id = 'fa53536e-083d-44ae-ab13-023bb1a92548'`

- **External systems:** None. Pure DCC + Supabase changes.

## Open follow-ups (carries forward to a future session)

- [ ] **Write a migration file for the security changes.** They're in prod but not in git, which means a re-deploy from scratch would regress. The `migrations-applied.yml` CI guardrail will flag this on the next push. File should capture: new handle_new_user, the safety trigger on client_access, the role-change alert trigger.
- [ ] **Audit the contractor org repo (`TheLocatorOfFunds-Team/Castle`) for anyone who has DCC access.** Per CLAUDE.md it's a read-only contractor snapshot — but if any contractor accidentally signed up at app.refundlocators.com prior to today, the `handle_new_user` default would have granted them admin. Check the `auth.users` table for any non-team email that signed up before today and currently sits at `role='user'` or `'admin'`. (Today's audit confirmed only the 4 known team accounts — but worth a periodic re-check.)
- [ ] **Kemper's `client_access.user_id` link.** PART 3 of the original panic SQL was meant to link his user_id to the existing client_access row for `surplus-mo1mu4n1f85p`. Result not pasted back in this session; might already be linked via the safety trigger we shipped after, but worth verifying with `select * from client_access where deal_id = 'surplus-mo1mu4n1f85p'`.
- [ ] **Consider hardening the DCC invite flow itself.** Right now `ClientPortalCard.invite()` inserts `client_access` then sends OTP. A future improvement: also check if an auth.users row already exists for that email and (if so) explicitly demote them to client AND link the row in the same transaction, instead of relying on the safety trigger. Belt-and-suspenders.
- [ ] **Add an "all admins" audit page in DCC.** Read-only view of `select * from profiles where role in ('user','admin')` that any admin can see. Catches future drift without needing SQL editor access.
- [ ] **Periodic security review cadence.** Weekly: run the audit query, eyeball # Ops for role-change alerts, scan auth.users for unexpected signups. Add to Nathan's calendar or to morning-sweep digest.
