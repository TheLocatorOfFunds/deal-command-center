-- Phase 1a of the deal.meta → columns migration (issue #326).
--
-- Promote 28 frequently-edited DCC-controlled meta keys to real columns.
-- Strictly additive: backfill from meta, UI continues to read meta until
-- Phase 2. Zero behavior change at this stage. Fully reversible by
-- dropping the new columns.
--
-- Why: deal.meta is a single jsonb grab-bag. Every input write replaces
-- the entire jsonb (`UPDATE deals SET meta = {...meta, key: newValue}`).
-- Two users editing different keys on the same deal can silently wipe
-- each other's fields because the second write's closure can lack the
-- first write's key. Real column-level UPDATEs (Phase 2) close this
-- entire bug class.
--
-- Out of scope for Phase 1a:
-- * intel-main-controlled keys (estimatedSurplus, salePrice, judgmentAmount,
--   totalDebt, courtAppraisalValue, minimumBidAmount, saleDate, courtCase,
--   county, ...) — these need coordination with intel-main per
--   DIRECTOR_DCC_INTERFACE.md. Tracked separately as Phase 1b.
-- * Nested objects (welcome_video, partner.*, investor.*, case_intel.*) —
--   stay as jsonb for now. Phase 4 may normalize.

begin;

-- ── Add columns ─────────────────────────────────────────────────────────
alter table public.deals
  add column if not exists verified                  boolean,
  add column if not exists verified_at               timestamptz,
  add column if not exists deceased                  boolean,
  add column if not exists deceased_at               timestamptz,
  add column if not exists obituary                  text,
  add column if not exists obituary_added_at         timestamptz,
  add column if not exists attorney_name             text,
  add column if not exists fee_pct                   numeric(5,2),
  add column if not exists attorney_fee              numeric(14,2),
  add column if not exists zillow_link               text,
  add column if not exists sheriff_docket_link       text,
  add column if not exists document_links            text,
  add column if not exists mortgage_history          text,
  add column if not exists involuntary_liens_details text,
  add column if not exists open_liens                text,
  add column if not exists open_liens_count          integer,
  add column if not exists mortgage_balance_1        numeric(14,2),
  add column if not exists lien_balance_1            numeric(14,2),
  add column if not exists est_available_equity      numeric(14,2),
  add column if not exists verified_surplus          numeric(14,2),
  add column if not exists contract_price            numeric(14,2),
  add column if not exists list_price                numeric(14,2),
  add column if not exists wholesale_price           numeric(14,2),
  add column if not exists lien_payoff               numeric(14,2),
  add column if not exists flat_fee                  numeric(14,2),
  add column if not exists buyer_agent_pct           numeric(5,2),
  add column if not exists closing_misc_pct          numeric(5,2),
  add column if not exists flip_strategy             text;

-- ── Backfill from meta ──────────────────────────────────────────────────
-- Tolerant of empty strings, string-encoded numbers, and missing keys.
-- numeric casts use nullif(trim(...), '') to avoid "invalid input syntax"
-- on blank values. boolean casts coerce 'true'/'false' or jsonb true/false.

-- Booleans
update public.deals set
  verified = case
    when (meta->>'verified') in ('true','false') then (meta->>'verified')::boolean
    else null
  end
where meta ? 'verified' and verified is null;

update public.deals set
  deceased = case
    when (meta->>'deceased') in ('true','false') then (meta->>'deceased')::boolean
    else null
  end
where meta ? 'deceased' and deceased is null;

-- Timestamps
update public.deals set verified_at = (nullif(trim(meta->>'verifiedAt'), ''))::timestamptz
  where (meta->>'verifiedAt') is not null and verified_at is null;

update public.deals set deceased_at = (nullif(trim(meta->>'deceased_at'), ''))::timestamptz
  where (meta->>'deceased_at') is not null and deceased_at is null;

update public.deals set obituary_added_at = (nullif(trim(meta->>'obituary_added_at'), ''))::timestamptz
  where (meta->>'obituary_added_at') is not null and obituary_added_at is null;

-- Text
update public.deals set obituary = nullif(trim(meta->>'obituary'), '') where (meta->>'obituary') is not null and obituary is null;
update public.deals set attorney_name = nullif(trim(meta->>'attorney'), '') where (meta->>'attorney') is not null and attorney_name is null;
update public.deals set zillow_link = nullif(trim(meta->>'zillowLink'), '') where (meta->>'zillowLink') is not null and zillow_link is null;
update public.deals set sheriff_docket_link = nullif(trim(meta->>'sheriffDocketLink'), '') where (meta->>'sheriffDocketLink') is not null and sheriff_docket_link is null;
update public.deals set document_links = nullif(trim(meta->>'documentLinks'), '') where (meta->>'documentLinks') is not null and document_links is null;
update public.deals set mortgage_history = nullif(trim(meta->>'mortgageHistory'), '') where (meta->>'mortgageHistory') is not null and mortgage_history is null;
update public.deals set involuntary_liens_details = nullif(trim(meta->>'involuntaryLiensDetails'), '') where (meta->>'involuntaryLiensDetails') is not null and involuntary_liens_details is null;
update public.deals set open_liens = nullif(trim(meta->>'openLiens'), '') where (meta->>'openLiens') is not null and open_liens is null;
update public.deals set flip_strategy = nullif(trim(meta->>'strategy'), '') where (meta->>'strategy') is not null and flip_strategy is null;

-- Integer
update public.deals set open_liens_count = (nullif(trim(meta->>'openLiensCount'), ''))::integer
  where (meta->>'openLiensCount') is not null and open_liens_count is null;

-- Numeric — money fields (14,2)
update public.deals set attorney_fee         = (nullif(trim(meta->>'attorneyFee'), ''))::numeric           where (meta->>'attorneyFee') is not null and attorney_fee is null;
update public.deals set mortgage_balance_1   = (nullif(trim(meta->>'mortgageBalance1'), ''))::numeric      where (meta->>'mortgageBalance1') is not null and mortgage_balance_1 is null;
update public.deals set lien_balance_1       = (nullif(trim(meta->>'lienBalance1'), ''))::numeric          where (meta->>'lienBalance1') is not null and lien_balance_1 is null;
update public.deals set est_available_equity = (nullif(trim(meta->>'estimatedAvailableEquity'), ''))::numeric where (meta->>'estimatedAvailableEquity') is not null and est_available_equity is null;
update public.deals set verified_surplus     = (nullif(trim(meta->>'verifiedSurplus'), ''))::numeric       where (meta->>'verifiedSurplus') is not null and verified_surplus is null;
update public.deals set contract_price       = (nullif(trim(meta->>'contractPrice'), ''))::numeric         where (meta->>'contractPrice') is not null and contract_price is null;
update public.deals set list_price           = (nullif(trim(meta->>'listPrice'), ''))::numeric             where (meta->>'listPrice') is not null and list_price is null;
update public.deals set wholesale_price      = (nullif(trim(meta->>'wholesalePrice'), ''))::numeric        where (meta->>'wholesalePrice') is not null and wholesale_price is null;
update public.deals set lien_payoff          = (nullif(trim(meta->>'lienPayoff'), ''))::numeric            where (meta->>'lienPayoff') is not null and lien_payoff is null;
update public.deals set flat_fee             = (nullif(trim(meta->>'flatFee'), ''))::numeric               where (meta->>'flatFee') is not null and flat_fee is null;

-- Numeric — percent fields (5,2)
update public.deals set fee_pct          = (nullif(trim(meta->>'feePct'), ''))::numeric        where (meta->>'feePct') is not null and fee_pct is null;
update public.deals set buyer_agent_pct  = (nullif(trim(meta->>'buyerAgentPct'), ''))::numeric where (meta->>'buyerAgentPct') is not null and buyer_agent_pct is null;
update public.deals set closing_misc_pct = (nullif(trim(meta->>'closingMiscPct'), ''))::numeric where (meta->>'closingMiscPct') is not null and closing_misc_pct is null;

-- Indexes only on lookup-eligible columns. None needed yet — UI reads via
-- single-row by id. Phase 2 may add an index on attorney_name if we ever
-- query "all deals for attorney X." Skipping for now.

commit;

-- ── Backfill audit (informational; run separately, comment out in prod) ──
-- select
--   count(*) filter (where verified is not null) as filled_verified,
--   count(*) filter (where (meta->>'verified') is not null) as meta_verified,
--   count(*) filter (where attorney_fee is not null) as filled_fee,
--   count(*) filter (where (meta->>'attorneyFee') is not null) as meta_fee
-- from public.deals;
