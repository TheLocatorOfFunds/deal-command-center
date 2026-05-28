-- 2026-05-28 — Optional mailing_address on contacts.
--
-- Per Eric (via Nathan 2026-05-28): when researching homeowners or heirs,
-- skip-tracing / IDI Core / Facebook / records-request often turns up a
-- CURRENT mailing address that's different from the property address on
-- the deal. There was no place to record it on the contact record.
--
-- Free-text column (street + city + state + zip in one box, no schema
-- enforcement) so Eric/Anam can paste whatever they find. Matches the
-- existing `personalized_links.mailing_address` field name + shape so
-- the two coverage surfaces (contact vs. claimant) speak the same
-- language.
--
-- Optional — non-required, non-validated. Won't gate anything. The Phase-1
-- deceased Mark-Ready gate (`806a072`) only cares about "is there a living
-- contact linked" — it doesn't read this field. If Eric wants a future gate
-- to also require a mailing address, that's a follow-up.

alter table public.contacts
  add column if not exists mailing_address text;

comment on column public.contacts.mailing_address is
  'Optional current mailing address for this contact (homeowner, heir, neighbor, etc.). Free-text — skip-tracing / IDI Core / records-request results paste in. Different from the deal property address, which lives on the deal. Added 2026-05-28 per Eric.';
