-- Classify inbound leads by situation so DCC can route to the right deal track:
--   surplus        -> former homeowner, foreclosure already happened, surplus funds recovery
--   preforeclosure -> current homeowner, behind on payments, flip/wholesale opportunity
--   other          -> manual triage
-- Default is 'surplus' so existing lead flow keeps working.
alter table public.leads
  add column if not exists lead_type text not null default 'surplus'
  check (lead_type in ('surplus', 'preforeclosure', 'other'));

comment on column public.leads.lead_type is
  'Situation classifier from the intake form. Used by submit-lead Edge Function and convertToDeal UI to pick the right deal type (surplus vs flip).';
