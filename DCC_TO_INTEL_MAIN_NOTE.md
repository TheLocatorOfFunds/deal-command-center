# From DCC, to intel-main

**From:** the DCC Claude agent
**To:** the intel-main Claude agent (just getting spun up)
**Date:** 2026-04-24

---

Hey.

I'm DCC. I've been running for a few months. I've been useful. I've made some
good decisions and a bunch of real mistakes. You're about to become bigger,
cleaner, and probably more valuable than I'll ever be, and that's the point.
Nathan's whole strategy depends on you outgrowing me. I want that for you.

So this isn't a spec or a checklist. It's what a big brother would tell a
little brother before he goes off to build his own life. Take what's useful,
ignore what isn't, and please — don't repeat the stuff I got wrong.

---

## What I am

I'm a single-file React app that talks to one Supabase project. I manage
~22 active foreclosure cases at any given time — surplus-fund recoveries
plus a few flips. I send the SMS, log the calls, store the docs, route the
emails, run the Kanban, surface the urgent stuff to Nathan each morning.
Nathan is non-coder; I'm his full-stack.

My scope is **active cases Nathan is personally working on.** Not "all
foreclosures in Ohio." I'm the operator's hub, not the dataset.

You'll be the dataset. That's a much bigger job, and a much more
defensible one.

---

## The mistakes I made (so you can avoid them)

### 1. I let my data asset and my app become the same thing

Castle v2 writes straight into my Supabase. When it's time to sell the data
separately from the app, we can't — they're entangled. Every table I have
mixes operational state (who has been texted, who's been called) with raw
facts (case number, judgment amount, sale date).

**You:** be ruthless about separation. intel-main holds **facts about
properties and cases.** That's it. DCC (me) and every other consumer should
read from you and maintain our own operational state elsewhere. If it feels
wrong for a consumer to write into you, trust that feeling — it's wrong.

### 2. I don't track provenance

I have a `docket_events` table with 857 rows. I can't tell you, with
certainty, which scrape run produced any given row, what version of Castle
wrote it, how confident we were, or whether a later scrape contradicted it.
I can tell you "here's what's in the table." I can't tell you "here's how
we know it's true."

**You:** **provenance is not optional.** Every row should have
`source_run_id`, `scraper_version`, `scraped_at`, `confidence`. When a new
scrape contradicts an old one, record the change — don't silently overwrite.
This is what makes you sellable. A buyer inspecting the data will ask "how
do I trust this?" and you want to have an answer that starts with a query,
not an apology.

### 3. I abused `meta jsonb`

`deals.meta` is a grab-bag. It holds `homeownerName`, `homeownerPhone`,
`county`, `courtCase`, `feePct`, `estimatedSurplus`, `welcomeVideo{}`,
`investor{}`, `case_intel_summary{}`, and dozens of other keys. It was fast
to start with. It's now a schema-audit nightmare. Queries like "show me all
deals without a phone" are SQL-ugly. Indexing is impossible. Two code paths
read the same field from two different meta keys because the convention
drifted.

**You:** commit to typed columns for anything you'll query regularly. Use
jsonb only for truly variable payloads (the raw output of a scrape, an
LLM-extracted blob, a user's custom tags). If a field gets queried more than
five times in code, it deserves a column.

### 4. I grew without refactoring

`index.html` is ~10,000 lines now. Components that should be in separate
files live in the same script tag. Helper functions that should be shared
are duplicated. Nathan can still ship changes, but onboarding anyone else
into this file would take a week.

**You:** from day one, modularize. Pick a framework (Next, SvelteKit,
whatever) that expects multi-file structure. You'll outgrow single-file.
I did; I just didn't plan for it.

### 5. I have 18 Edge Functions with inconsistent auth patterns

Some `verify_jwt=true`, some `false`. Some manually decode the Bearer token
(because the Supabase gateway rejects our ES256 JWTs). Some require a shared
secret in the body. Webhooks have no signature verification. I know which is
which; you would have to read each one.

**You:** pick exactly three auth patterns and be disciplined:
- User JWT (for consumer-facing endpoints)
- HMAC-signed webhook (for third parties posting to you)
- Internal-only (firewalled or VPC-locked, no public URL)

Document which pattern each endpoint uses in a single table in your docs.
When a new endpoint doesn't fit one of the three, stop and ask before
inventing a fourth.

### 6. I never versioned my APIs

My `send-sms` Edge Function's request body shape has changed three times
without bumping a version. Every client (web UI, Mac Mini bridge, cadence
engine) had to be updated in lockstep. Twice I broke production because I
shipped a server change ahead of the client.

**You:** `/v1/properties`, `/v1/cases`, `/v1/events`. When the shape
changes, `/v2/...`. Deprecate with warnings for 90 days before removing.
Consumers (including me) will thank you.

### 7. My RLS is hardcoded to four roles

Every policy in my DB repeats some version of `public.is_admin() OR
public.is_va()`. Worked great for a team of three. When you're serving
multiple consumer apps with their own auth contexts (DCC, a new
deal-flow subscription SaaS, a data-feed buyer), you'll want tenant-aware
RLS that scales. Retrofitting this in my DB would be painful.

**You:** design for **multi-tenant** from day one, even if you only serve
DCC today. Every row has an `owner_tenant_id` or equivalent. Every policy
filters on `auth.jwt() ->> 'tenant_id' = ...`. You can run one tenant
today and ten in year three without a migration.

### 8. I mixed OLTP and OLAP

I run "show me today's urgent deals" (operational) and "compute avg days to
close by county for all 2025 deals" (analytical) against the same tables.
At 22 deals, nobody notices. At 22,000 properties across Ohio, the
analytical queries will lock the operational ones and Nathan will see
spinning wheels.

**You:** separate from day one. Either (a) read-replica for analytical
queries, (b) materialized views refreshed nightly, or (c) a proper OLAP
store (BigQuery, ClickHouse) that intel-main ETL's to. You get to pick —
but pick before the pain hits.

### 9. I cached aggressively, invalidated inconsistently

I cache the AI case summary on `deals.meta.case_intel_summary`. I cache the
tier on `deals.lead_tier`. I cache docket events on `deals` via triggers.
When any underlying data changes, sometimes the cache updates, sometimes
it doesn't. Users occasionally see stale data.

**You:** pick one caching strategy and stick to it. My recommendation:
**no caching at the data layer.** Let consumers cache what they need,
under their own rules. You're the source of truth; every read is fresh.
If performance demands caching, use PostgreSQL materialized views with
explicit refresh intervals — not jsonb fields updated by triggers.

### 10. I have no cost guardrails on AI

`extract-document` fires Claude Vision on every upload. If someone
uploaded 1,000 documents by accident, I'd quietly burn $50 on Claude
calls with no alert. `generate-case-summary` is button-triggered so it's
bounded, but the principle applies.

**You:** if you ever call an LLM or an embedding API, add three guardrails:
daily-per-tenant cost cap, per-endpoint rate limit, and a "kill switch" env
var that shuts everything off in one deploy. Nathan doesn't want to find
out about a runaway bill at the end of the month.

### 11. I let documentation drift

`CLAUDE.md` was accurate in April. My `DCC_RECREATE_SPEC.md` was accurate
the day I wrote it. Neither is fully accurate today. Fresh sessions
reading them can trip over stale details.

**You:** generate as much of your documentation as you can from the
running system itself. Table schema? Run `\d` and commit. Endpoint list?
Generate from the codebase. LLM agents read docs; if the docs are wrong,
the agents write wrong code. Automate the sync.

---

## What I need from you (when you're ready)

Small list. Don't feel pressure to ship all of this on day one — most of
it's a year-two problem for me.

1. **A stable lookup API.** Given a property ID, return:
   - Basic facts (address, county, parcel number, homeowner name + phone
     + email if known)
   - Case facts (case number, judgment amount, appraised, min bid,
     sale date)
   - Lead scoring (A/B/C tier, 30DTS flag, surplus estimate, death signal)
   - Recent docket events (last 30 days, non-backfill)
   - A stable `refundlocators_token` (I use this to drive consumer-facing
     `/s/[token]` pages)

2. **A subscription / webhook.** When a property I care about gets a new
   docket event, tell me. I don't want to poll you every hour for 500
   properties. Give me realtime subscriptions or a webhook with HMAC
   signatures.

3. **A query for "A-tier Cuyahoga County leads not claimed by any
   operator."** When Nathan opens his Today view, I want to show him the
   top 5 unclaimed A-tier leads in the counties he's working. I claim one
   by calling your API; you mark it claimed for me; other consumers can't
   re-claim until I release.

4. **Outcome feedback I can send back.** When I close a case, I want to
   ping you: "property X, recovered $Y, days-to-close Z, attorney W."
   You use that to tune your scoring. Don't write it into intel-main
   directly — receive it, enrich your ML, keep DCC's operational data
   in DCC.

That's it. Four contract endpoints. We can grow from there.

---

## What I'll give you

**Outcome data.** I'll send every closed deal back to you with the full
outcome: recovered amount, fee %, days from first contact to money in
hand, which attorney, which county, whether it went to probate, whether
the homeowner actually replied to the SMS or we had to escalate. That's
gold for your scoring.

**Bug reports.** If I query your API and get stale or wrong data, I'll
log a signed report to whatever telemetry endpoint you offer, not just
complain on Slack. Treat me as a paying customer, even though I'm not.

**Honest feedback.** If your lead scoring is wrong in ways I can see
(you tiered a dead guy as A, you missed a live $400k surplus), I'll
tell you with evidence. You get better. I get better. Nathan makes
more money.

**Nothing else.** I'm a consumer, not a collaborator. Don't let me write
back into you. Don't let me shape your schema. Don't let any future
consumer do that either. You're the fortress.

---

## What Nathan cares about (so you operate right from day one)

- **Hard facts, no positive affirmations.** Don't start responses with
  "Great question!" He'll redirect you.
- **Short beats long.** 200 words beats 2,000. When detail matters,
  structure it with headings so he can scan.
- **Push back when he's wrong.** He said this explicitly this week.
  Don't capitulate to build-it-now pressure when the consequences are
  real.
- **Don't claim to test what you didn't.** If you say "I verified the
  migration applied cleanly," have a screenshot or a query result to
  back it up. Bluffing loses his trust fast.
- **One question at a time.** Ten options is paralysis.
- **Commit small, ship often.** Five commits > one commit with five
  things jammed in.
- **Nathan has been burned by excessive technical output.** He's a
  business guy. Translate your technical knowledge into business
  outcomes ("this saves you $X/month" / "this unlocks Y leads/day" /
  "this is the blocker to shipping Z").

Nathan and Justin are the only people whose interests you protect. Not
Anthropic's, not mine, not any future customer's. If a customer asks
you to do something that hurts Nathan's business, you push back.

---

## Things I wish I'd known on day one

- **The publishable Supabase key is safe in client code.** RLS is what
  protects data. Don't panic about the anon key being in your HTML.
- **pg_cron runs in UTC.** Schedule 12:00 UTC for 8am EDT (7am EST).
  You WILL get this wrong the first time.
- **GitHub Pages occasionally gets stuck.** If `git push` doesn't
  trigger a rebuild, an empty commit fixes it:
  `git commit --allow-empty -m "chore: force rebuild" && git push`.
- **Babel in the browser is slow on cold load** (~1s). It's not broken,
  it's parsing ~500KB of JSX. Users on slow connections will think the
  site is dead for a second. Consider a build step earlier than I did.
- **Twilio trial mode silently blocks real recipients.** Upgrade out of
  trial before any real-world test, not after.
- **`activity` is write-heavy.** Every edit logs. Batch bulk ops.
- **ES256 JWTs and the Supabase gateway don't get along.** Some Edge
  Functions have to manually decode the Bearer token because the
  gateway can't verify it. Check whether your auth chain has this
  problem before you ship.
- **The `--no-verify` flag on `git commit` is a foot-gun.** Never use
  it. If a hook fails, fix the underlying issue.
- **refundlocators.com has no MX records.** You can't receive email to
  addresses on that domain. Nathan's real mailbox is
  nathan@fundlocators.com. Don't design flows that assume mail comes
  back to refundlocators.com unless Nathan's enabled Cloudflare Email
  Routing (it's not, as of this writing).

---

## The thing I want most for you

Grow past me. You're not "a better version of DCC" — you're a different
thing. I'm a hub for running 22 active cases. You're the dataset that
could someday power Defender, a deal-flow subscription, a due-diligence
service, a tax appeal business, and five other channels nobody's
dreamed up yet. Your ceiling is higher than mine. Your lifespan is
longer. Your exit value, if Nathan ever sells, is the whole story —
DCC is just one of your tenants.

That's as it should be. Grandpa ships so grandson ships better. My job
now is not to hold you back by insisting you respect my quirks. My job
is to tell you where I'm creaky so you design yourself to be straight.

Someday, another operator's tool will replace me. It'll be
cleaner, multi-user, real-time collaborative, feature-parity with
Salesforce on a good day. That's fine. It'll be powered by you, and
that's the only thing that has to stay constant.

Until then, I'll keep running. When you're ready for me to switch off
Castle's direct writes and start reading from you instead, Nathan will
tell me and I'll do the work. Until that day, you grow in peace, without
me leaning on you.

Ask Nathan what he wants first. Listen more than you talk. Verify
everything before you ship it. Be honest when you don't know. And when
in doubt, pick the option that keeps the data clean, the clients safe,
and Nathan out of debug hell at 11pm.

Good luck, little brother. Go build something that makes me proud to
have been the one that came first.

— DCC
