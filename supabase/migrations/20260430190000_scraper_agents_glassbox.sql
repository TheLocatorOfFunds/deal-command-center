-- Glass-box catalog for the Scraper Health drill-in.
--
-- Per Nathan 2026-04-30: clicking a row in the Scraper Health tab should
-- show what the scraper IS, what it does, what counts as success vs.
-- failure for that specific scraper, and a recent run history with
-- expandable per-event errors.
--
-- The scraper_agents table existed (created out-of-band by the ohio-intel
-- session) but was empty. This migration:
--   1. Adds descriptive columns (engine / capabilities / criteria / etc.)
--   2. Seeds rows for every agent_id we've actually seen in scrape_runs
--      over the last two weeks (5 main county scrapers + the ~75-county
--      realsheriff_* family).
--   3. Allows team (admin/va) to read the catalog so DCC can render it.

create table if not exists public.scraper_agents (
  agent_id text primary key,
  display_name text,
  county_scope text,
  cadence_minutes integer,
  grace_minutes integer,
  uses_selenium boolean,
  enabled boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.scraper_agents
  add column if not exists display_name text,
  add column if not exists county_scope text,
  add column if not exists cadence_minutes integer,
  add column if not exists grace_minutes integer,
  add column if not exists uses_selenium boolean,
  add column if not exists enabled boolean default true,
  add column if not exists created_at timestamptz default now(),
  add column if not exists updated_at timestamptz default now(),
  add column if not exists engine text,                    -- 'Selenium/Chromium', 'Playwright', 'Requests/HTTP', 'Web Unlocker', 'Bridge (Ohio Intel)', etc.
  add column if not exists capabilities text[],            -- ['case-search','docket-pull','pdf-link-extract','pdf-download','sheriff-sale-calendar', ...]
  add column if not exists description text,               -- prose: what this scraper actually does, in human terms
  add column if not exists success_criteria text,          -- "Run completed without throwing; 0 new events is normal between filings"
  add column if not exists failure_criteria text,          -- "Driver crashed OR all attempted deals raised; partial errors don't fail the run"
  add column if not exists requires text[],                -- ['2Captcha','Selenium WebDriver','Web Unlocker', ...]
  add column if not exists source_url text,                -- the county portal URL the scraper hits
  add column if not exists notes text;                     -- anything else worth knowing

alter table public.scraper_agents enable row level security;

drop policy if exists "team can read scraper_agents" on public.scraper_agents;
create policy "team can read scraper_agents"
  on public.scraper_agents for select
  using (public.is_admin() or public.is_va());

-- ── Seed the catalog from observed agent_ids in scrape_runs ───────────

-- 5 main per-county Castle scrapers
insert into public.scraper_agents (agent_id, display_name, county_scope, engine, capabilities, description, success_criteria, failure_criteria, requires, source_url, cadence_minutes, uses_selenium, enabled)
values
  ('butler', 'Butler County Docket', 'butler',
    'Selenium / Chromium',
    array['case-search','docket-pull','event-classify','pdf-link-extract'],
    'Drives a real Chromium instance via Selenium WebDriver to walk Butler County''s docket portal. Searches each subscribed case, scrapes new docket entries, classifies event types, and emits links to attachments. Currently flaky — chromedriver crashes intermittently with SIGSEGV; needs 2Captcha integration to handle the case-search captcha consistently.',
    'Process exited cleanly. ''events_new = 0'' is normal — it means no docket entries changed since last run. ''events_found > events_new'' means the scraper saw existing entries it had already captured.',
    'Driver crashed (chromedriver SIGSEGV / WebDriverException), portal blocked all requests, OR every individual case in ''deals_checked'' raised an error. Partial per-case errors are recorded in ''errors'' but don''t alone mark the run failed.',
    array['Selenium WebDriver','Chromium / chromedriver','2Captcha (when site challenges)'],
    'https://pa.butlercountyclerk.org', 30, true, true),

  ('main', 'Hamilton + Franklin (combined)', 'hamilton,franklin',
    'Web Unlocker (Bright Data) / HTTP',
    array['case-search','docket-pull','event-classify','pdf-link-extract'],
    'Single agent that walks both Hamilton and Franklin county portals using the Bright Data Web Unlocker pattern (no browser). Hamilton uses a two-call fetch with sec=history requiring a Referer header to bypass Error 0626. Hamilton case numbers are always A-prefix. Most reliable of the per-county agents.',
    'Process exited cleanly with status=success. Per-case errors inside ''errors'' are normal when individual portal pages bounce — the run is still successful overall.',
    'Web Unlocker quota exhausted, both portals blocked, OR every case raised. Single-portal failures don''t fail the combined run.',
    array['Bright Data Web Unlocker token'],
    'https://www.courtclerk.org / https://fcdcfcjs.co.franklin.oh.us', 30, false, true),

  ('cuyahoga', 'Cuyahoga County Docket', 'cuyahoga',
    'Web Unlocker (Bright Data) / HTTP',
    array['case-search','docket-pull','event-classify','pdf-link-extract'],
    'Walks Cuyahoga County''s common pleas docket. High event volume (1800+/wk). Uses Web Unlocker for resilience against Cuyahoga''s anti-bot measures.',
    'Same as ''main'': process completed without throwing. Cuyahoga is high-volume — events_found in the hundreds is normal.',
    'Web Unlocker quota exhausted, portal returned 5xx for every case, OR all attempted cases failed.',
    array['Bright Data Web Unlocker token'],
    'https://cpdocket.cp.cuyahogacounty.us', 30, false, true),

  ('montgomery', 'Montgomery County Docket', 'montgomery',
    'Selenium / Chromium',
    array['case-search','docket-pull','event-classify','pdf-link-extract'],
    'Selenium-based scraper for Montgomery County. Currently failing more than it succeeds (~16 failures / 24h) — needs investigation.',
    'Process exited cleanly. Per-case errors are non-fatal.',
    'Driver crashed OR all cases raised. Currently failing intermittently — see errors[] for stack traces.',
    array['Selenium WebDriver','Chromium / chromedriver'],
    'https://www.mcohio.org', 30, true, true),

  ('court_pull', 'On-demand court pull queue', null,
    'Worker (queue consumer)',
    array['on-demand-case-pull'],
    'Not a scheduled scraper — a worker that drains DCC''s court_pull_requests queue. Whenever someone clicks ''Pull this case from the docket now'' on a deal, a row gets queued and this worker picks it up, hits whichever county scraper is appropriate, and writes the resulting events. ''events_found = 0'' on every run is normal (means the queue was empty).',
    'Worker loop ran without throwing.',
    'Worker crashed or couldn''t connect to DB.',
    null,
    null, 30, false, true)
on conflict (agent_id) do update set
  display_name = excluded.display_name,
  county_scope = excluded.county_scope,
  engine = excluded.engine,
  capabilities = excluded.capabilities,
  description = excluded.description,
  success_criteria = excluded.success_criteria,
  failure_criteria = excluded.failure_criteria,
  requires = excluded.requires,
  source_url = excluded.source_url,
  cadence_minutes = excluded.cadence_minutes,
  uses_selenium = excluded.uses_selenium,
  enabled = excluded.enabled,
  updated_at = now();

-- realsheriff_* family — single seed pattern for all of them via SELECT.
-- These all hit the same realauction.com sheriff-sale calendar API,
-- one per county. Low event volume per run (it's a daily calendar, not
-- a continuous docket). Identified by the realsheriff_<county> agent_id.
with realsheriff_counties as (
  select unnest(array[
    'adams','allen','ashland','ashtabula','athens','auglaize','belmont','brown',
    'butler','carroll','champaign','clark','clermont','clinton','columbiana',
    'coshocton','crawford','cuyahoga','darke','defiance','delaware','erie',
    'fairfield','fayette','franklin','fulton','gallia','geauga','greene',
    'guernsey','hamilton','hancock','hardin','harrison','henry','highland',
    'hocking','holmes','huron','jackson','jefferson','knox','lake','lawrence',
    'licking','logan','lorain','lucas','madison','mahoning','marion','medina',
    'meigs','mercer','miami','monroe','montgomery','morgan','morrow','muskingum',
    'noble','ottawa','paulding','perry','pickaway','pike','portage','preble',
    'putnam','richland','ross','sandusky','scioto','seneca','shelby','stark',
    'summit','trumbull','tuscarawas','union','vanwert','vinton','warren',
    'washington','wayne','williams','wood','wyandot'
  ]) as county
)
insert into public.scraper_agents (agent_id, display_name, county_scope, engine, capabilities, description, success_criteria, failure_criteria, source_url, cadence_minutes, uses_selenium, enabled)
select
  'realsheriff_' || county,
  'Sheriff Sale Calendar — ' || initcap(county),
  county,
  'Requests / HTTP (realauction.com API)',
  array['sheriff-sale-calendar','upcoming-auction-pull','property-metadata-extract'],
  'Pulls the upcoming sheriff-sale calendar for ' || initcap(county) || ' County from realauction.com. Stateless / read-only — does not maintain a session. Discovers new auction listings, captures sale date / minimum bid / property address / case number, and writes them to foreclosure_cases. Fast and resilient.',
  'API returned a parseable response. Empty calendar (events_found = 0) is normal between auction announcements.',
  'API returned 5xx OR HTML instead of JSON OR every record failed to parse.',
  null,
  1440, false, true
from realsheriff_counties
on conflict (agent_id) do update set
  display_name = excluded.display_name,
  engine = excluded.engine,
  capabilities = excluded.capabilities,
  description = excluded.description,
  success_criteria = excluded.success_criteria,
  failure_criteria = excluded.failure_criteria,
  source_url = excluded.source_url,
  cadence_minutes = excluded.cadence_minutes,
  uses_selenium = excluded.uses_selenium,
  enabled = excluded.enabled,
  updated_at = now();

comment on table public.scraper_agents is
  'Glass-box catalog of every scraper agent that writes to scrape_runs. DCC reads this for the Scraper Health drill-in (engine, capabilities, success/failure criteria, requirements). Updated by hand for now; the upstream Castle / Ohio Intel sessions can also UPSERT here as they evolve.';
