-- 2026-05-25 — Fix `sweep_mint_homeowner_tokens()`: ambiguous `deal_id`.
--
-- The pg_cron job `sweep-mint-homeowner-tokens` was failing every run with
-- "column reference \"deal_id\" is ambiguous" (flooding the in-DCC System
-- Alerts queue). Root cause: the function's RETURNS TABLE declares an output
-- column `deal_id`, which PL/pgSQL treats as a variable; the line
-- `... FROM personalized_links WHERE deal_id = d.did::uuid` then can't tell
-- the variable from the `personalized_links.deal_id` column. Every other
-- reference in the function is already alias-qualified (pl./cd./sample.) — this
-- was the one bare reference. Fix: qualify it as `personalized_links.deal_id`.
--
-- Second latent bug the ambiguity error was masking: personalized_links.deal_id
-- is TEXT (deal IDs are text like 'sf-thacker', not uuid), so the original
-- `= d.did::uuid` cast errored with "operator does not exist: text = uuid".
-- The function never ran before — the parse-time ambiguity error fired first,
-- so this was never reached. Fixed by dropping the ::uuid cast (d.did is text).
-- CREATE OR REPLACE only — the cron schedule + comment from 20260519190000 stay.

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
    WHERE personalized_links.deal_id = d.did
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
