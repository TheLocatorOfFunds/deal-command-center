-- Phase 2 of the deal.meta -> columns migration (issue #326).
--
-- Two pieces:
--   1. Extend Phase 1a's 28 columns with 5 more DCC-controlled fields
--      (state + 4 date fields) that Eric specifically reported as the
--      "disappearing" inputs: courtAppraisalOrderDate and
--      confirmationOfSaleDate. Backfill from existing meta.
--   2. Install BEFORE UPDATE trigger tg_sync_deals_meta_from_columns()
--      that mirrors any column change into the matching meta camelKey
--      in the SAME UPDATE statement (no recursion).
--
-- Why the trigger:
--   * Existing readers (mobile, edge functions, intel-main) still read
--     meta.<camelKey>. Keeping meta in sync prevents stale reads.
--   * The DCC UI moves to writing columns directly in this same commit.
--     The trigger guarantees meta stays current without any client-side
--     dual-write. Single UPDATE -> one realtime echo -> consistent state.
--
-- Why this is the actual fix for the field-blanking bug:
--   * The OLD path was `update deals set meta = {...stale_meta, ...patch}`.
--     Two users editing different keys each carry a stale snapshot of
--     the OTHER user's keys; the second write wins and silently wipes
--     the first user's edits. Live repro: Eric, 2026-06-08.
--   * The NEW path is `update deals set col_a = X` and a separate
--     `update deals set col_b = Y`. Postgres atomically merges these at
--     the column level. Cross-key clobber becomes impossible.
--
-- Out of scope for Phase 2:
--   * intel-main-controlled keys (estimatedSurplus, salePrice, ...) ->
--     coordinate with intel-main per DIRECTOR_DCC_INTERFACE.md. Phase 1b.
--   * Dropping meta entirely -> Phase 4, after every reader is updated
--     to use columns directly.

begin;

-- Phase 1a extension: 5 more DCC-controlled date/text fields ----------
alter table public.deals
  add column if not exists state                      text,
  add column if not exists foreclosure_file_date      date,
  add column if not exists confirmation_of_sale_date  date,
  add column if not exists redemption_deadline        date,
  add column if not exists court_appraisal_order_date date;

update public.deals
  set state = nullif(trim(meta->>'state'), '')
  where (meta->>'state') is not null and state is null;

update public.deals
  set foreclosure_file_date = (nullif(trim(meta->>'foreclosureFileDate'), ''))::date
  where (meta->>'foreclosureFileDate') is not null and foreclosure_file_date is null;

update public.deals
  set confirmation_of_sale_date = (nullif(trim(meta->>'confirmationOfSaleDate'), ''))::date
  where (meta->>'confirmationOfSaleDate') is not null and confirmation_of_sale_date is null;

update public.deals
  set redemption_deadline = (nullif(trim(meta->>'redemptionDeadline'), ''))::date
  where (meta->>'redemptionDeadline') is not null and redemption_deadline is null;

update public.deals
  set court_appraisal_order_date = (nullif(trim(meta->>'courtAppraisalOrderDate'), ''))::date
  where (meta->>'courtAppraisalOrderDate') is not null and court_appraisal_order_date is null;

-- Column -> meta mirror trigger ---------------------------------------
create or replace function public.tg_sync_deals_meta_from_columns()
returns trigger language plpgsql security definer set search_path = public
as $fn$
declare
  m jsonb := coalesce(NEW.meta, '{}'::jsonb);
begin
  if NEW.verified                  is distinct from OLD.verified                  then m := m || jsonb_build_object('verified',                NEW.verified);                  end if;
  if NEW.verified_at               is distinct from OLD.verified_at               then m := m || jsonb_build_object('verifiedAt',              NEW.verified_at);               end if;
  if NEW.deceased                  is distinct from OLD.deceased                  then m := m || jsonb_build_object('deceased',                NEW.deceased);                  end if;
  if NEW.deceased_at               is distinct from OLD.deceased_at               then m := m || jsonb_build_object('deceased_at',             NEW.deceased_at);               end if;
  if NEW.obituary                  is distinct from OLD.obituary                  then m := m || jsonb_build_object('obituary',                NEW.obituary);                  end if;
  if NEW.obituary_added_at         is distinct from OLD.obituary_added_at         then m := m || jsonb_build_object('obituary_added_at',       NEW.obituary_added_at);         end if;
  if NEW.attorney_name             is distinct from OLD.attorney_name             then m := m || jsonb_build_object('attorney',                NEW.attorney_name);             end if;
  if NEW.fee_pct                   is distinct from OLD.fee_pct                   then m := m || jsonb_build_object('feePct',                  NEW.fee_pct);                   end if;
  if NEW.attorney_fee              is distinct from OLD.attorney_fee              then m := m || jsonb_build_object('attorneyFee',             NEW.attorney_fee);              end if;
  if NEW.zillow_link               is distinct from OLD.zillow_link               then m := m || jsonb_build_object('zillowLink',              NEW.zillow_link);               end if;
  if NEW.sheriff_docket_link       is distinct from OLD.sheriff_docket_link       then m := m || jsonb_build_object('sheriffDocketLink',       NEW.sheriff_docket_link);       end if;
  if NEW.document_links            is distinct from OLD.document_links            then m := m || jsonb_build_object('documentLinks',           NEW.document_links);            end if;
  if NEW.mortgage_history          is distinct from OLD.mortgage_history          then m := m || jsonb_build_object('mortgageHistory',         NEW.mortgage_history);          end if;
  if NEW.involuntary_liens_details is distinct from OLD.involuntary_liens_details then m := m || jsonb_build_object('involuntaryLiensDetails', NEW.involuntary_liens_details); end if;
  if NEW.open_liens                is distinct from OLD.open_liens                then m := m || jsonb_build_object('openLiens',               NEW.open_liens);                end if;
  if NEW.open_liens_count          is distinct from OLD.open_liens_count          then m := m || jsonb_build_object('openLiensCount',          NEW.open_liens_count);          end if;
  if NEW.mortgage_balance_1        is distinct from OLD.mortgage_balance_1        then m := m || jsonb_build_object('mortgageBalance1',        NEW.mortgage_balance_1);        end if;
  if NEW.lien_balance_1            is distinct from OLD.lien_balance_1            then m := m || jsonb_build_object('lienBalance1',            NEW.lien_balance_1);            end if;
  if NEW.est_available_equity      is distinct from OLD.est_available_equity      then m := m || jsonb_build_object('estimatedAvailableEquity',NEW.est_available_equity);      end if;
  if NEW.verified_surplus          is distinct from OLD.verified_surplus          then m := m || jsonb_build_object('verifiedSurplus',         NEW.verified_surplus);          end if;
  if NEW.contract_price            is distinct from OLD.contract_price            then m := m || jsonb_build_object('contractPrice',           NEW.contract_price);            end if;
  if NEW.list_price                is distinct from OLD.list_price                then m := m || jsonb_build_object('listPrice',               NEW.list_price);                end if;
  if NEW.wholesale_price           is distinct from OLD.wholesale_price           then m := m || jsonb_build_object('wholesalePrice',          NEW.wholesale_price);           end if;
  if NEW.lien_payoff               is distinct from OLD.lien_payoff               then m := m || jsonb_build_object('lienPayoff',              NEW.lien_payoff);               end if;
  if NEW.flat_fee                  is distinct from OLD.flat_fee                  then m := m || jsonb_build_object('flatFee',                 NEW.flat_fee);                  end if;
  if NEW.buyer_agent_pct           is distinct from OLD.buyer_agent_pct           then m := m || jsonb_build_object('buyerAgentPct',           NEW.buyer_agent_pct);           end if;
  if NEW.closing_misc_pct          is distinct from OLD.closing_misc_pct          then m := m || jsonb_build_object('closingMiscPct',          NEW.closing_misc_pct);          end if;
  if NEW.flip_strategy             is distinct from OLD.flip_strategy             then m := m || jsonb_build_object('strategy',                NEW.flip_strategy);             end if;
  if NEW.state                     is distinct from OLD.state                     then m := m || jsonb_build_object('state',                   NEW.state);                     end if;
  if NEW.foreclosure_file_date     is distinct from OLD.foreclosure_file_date     then m := m || jsonb_build_object('foreclosureFileDate',     NEW.foreclosure_file_date);     end if;
  if NEW.confirmation_of_sale_date is distinct from OLD.confirmation_of_sale_date then m := m || jsonb_build_object('confirmationOfSaleDate',  NEW.confirmation_of_sale_date); end if;
  if NEW.redemption_deadline       is distinct from OLD.redemption_deadline       then m := m || jsonb_build_object('redemptionDeadline',      NEW.redemption_deadline);       end if;
  if NEW.court_appraisal_order_date is distinct from OLD.court_appraisal_order_date then m := m || jsonb_build_object('courtAppraisalOrderDate', NEW.court_appraisal_order_date); end if;

  NEW.meta := m;
  return NEW;
end;
$fn$;

drop trigger if exists tg_sync_deals_meta_from_columns on public.deals;
create trigger tg_sync_deals_meta_from_columns
before update on public.deals
for each row
execute function public.tg_sync_deals_meta_from_columns();

commit;
