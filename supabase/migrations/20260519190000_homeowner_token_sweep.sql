-- 20260519190000_homeowner_token_sweep.sql
-- Safety-net: auto-mint missing bare homeowner tokens on surplus deals
-- where Castle minted only family-contact tokens (e.g. joybaker-emily,
-- joybaker-maxwell, no joybaker).
--
-- Real root cause is in Castle's ghl-import token-mint path (see ferry
-- castle-2026-05-19-mint-homeowner-bare-tokens.md). This is a sweep that
-- keeps DCC self-healing until Castle's fix ships.
--
-- Behavior: every 15 min, for each surplus deal that:
--   1. has ≥1 personalized_links row, AND
--   2. has NO bare-token row (no token without a dash), AND
--   3. has a contact_deals row where contacts.kind = 'homeowner'
-- ...mint a bare token by stripping the suffix from any existing token
-- and copying case-detail fields from a sample row.

CREATE OR REPLACE FUNCTION public.sweep_mint_homeowner_tokens()
RETURNS TABLE (deal_id text, minted_token text, homeowner_name text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  d         record;
  sample    personalized_links%ROWTYPE;
  bare      text;
  homeowner record;
  hn_first  text;
  hn_last   text;
  hn_phone  text;
BEGIN
  FOR d IN
    SELECT DISTINCT pl.deal_id::text AS did
    FROM personalized_links pl
    JOIN deals dl ON dl.id = pl.deal_id::text
    WHERE dl.type = 'surplus'
      AND pl.deal_id IS NOT NULL
      -- (b) NO bare token exists for this deal
      AND NOT EXISTS (
        SELECT 1 FROM personalized_links pl2
        WHERE pl2.deal_id = pl.deal_id
          AND pl2.token NOT LIKE '%-%'
      )
      -- (c) homeowner contact exists
      AND EXISTS (
        SELECT 1
        FROM contact_deals cd
        JOIN contacts c ON c.id = cd.contact_id
        WHERE cd.deal_id = pl.deal_id::text
          AND c.kind = 'homeowner'
      )
  LOOP
    -- Pull any one existing personalized_links row to template from
    SELECT * INTO sample
    FROM personalized_links
    WHERE deal_id = d.did::uuid
    LIMIT 1;

    IF sample IS NULL THEN CONTINUE; END IF;

    -- Strip the "-suffix" to get the bare token
    bare := regexp_replace(sample.token, '-[^-]+$', '');
    IF bare = sample.token OR bare IS NULL OR length(bare) = 0 THEN
      CONTINUE;
    END IF;

    -- Defensive: skip if some other process minted the bare in the meantime
    IF EXISTS (SELECT 1 FROM personalized_links WHERE token = bare) THEN
      CONTINUE;
    END IF;

    -- Look up the homeowner contact
    SELECT c.id, c.name, c.phone INTO homeowner
    FROM contact_deals cd
    JOIN contacts c ON c.id = cd.contact_id
    WHERE cd.deal_id = d.did
      AND c.kind = 'homeowner'
    LIMIT 1;

    IF homeowner.id IS NULL THEN CONTINUE; END IF;

    -- Parse "First Last" → first_name + last_name
    hn_first := split_part(homeowner.name, ' ', 1);
    hn_last  := NULLIF(regexp_replace(homeowner.name, '^\S+\s*', ''), '');

    -- First phone in the comma-separated list, E.164 if it looks like a US number
    hn_phone := split_part(coalesce(homeowner.phone, ''), ',', 1);
    hn_phone := regexp_replace(hn_phone, '\D', '', 'g');
    IF length(hn_phone) = 10 THEN
      hn_phone := '+1' || hn_phone;
    ELSIF length(hn_phone) = 11 AND left(hn_phone, 1) = '1' THEN
      hn_phone := '+' || hn_phone;
    ELSE
      hn_phone := NULL;
    END IF;

    -- INSERT the bare row, copying case-specific fields from sample
    BEGIN
      INSERT INTO personalized_links (
        token, deal_id, contact_id, first_name, last_name, phone,
        relationship, source,
        case_id, case_number, county, property_address, mailing_address,
        sale_date, sale_price, judgment_amount,
        estimated_surplus_low, estimated_surplus_high,
        expires_at, view_count, converted_to_contract,
        ghl_contact_id, email
      ) VALUES (
        bare, sample.deal_id, homeowner.id, hn_first, hn_last, hn_phone,
        'homeowner', 'dcc-homeowner-sweep',
        sample.case_id, sample.case_number, sample.county, sample.property_address, NULL,
        sample.sale_date, sample.sale_price, sample.judgment_amount,
        sample.estimated_surplus_low, sample.estimated_surplus_high,
        sample.expires_at, 0, false,
        NULL, NULL
      );

      deal_id := d.did;
      minted_token := bare;
      homeowner_name := homeowner.name;
      RETURN NEXT;
    EXCEPTION WHEN unique_violation THEN
      -- Race condition with Castle or another sweep; just skip
      CONTINUE;
    END;
  END LOOP;

  RETURN;
END;
$func$;

COMMENT ON FUNCTION public.sweep_mint_homeowner_tokens() IS
  'Safety net (added 2026-05-19): when Castle skips minting a bare homeowner token on a ghl-import surplus deal, this sweep finds it within 15 min and creates the row. The trigger sync_refundlocators_token then propagates to deals.refundlocators_token. See castle-2026-05-19-mint-homeowner-bare-tokens.md ferry for root cause.';

-- ── Schedule via pg_cron, every 15 min ──
SELECT cron.schedule(
  'sweep-mint-homeowner-tokens',
  '*/15 * * * *',
  $$SELECT count(*) FROM public.sweep_mint_homeowner_tokens();$$
);

-- ── Verify ──
-- SELECT * FROM public.sweep_mint_homeowner_tokens();  -- run once to test
-- SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'sweep-mint-homeowner-tokens';
