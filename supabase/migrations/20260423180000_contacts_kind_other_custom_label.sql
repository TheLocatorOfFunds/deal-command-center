-- When kind = 'other', let the user type a custom label (e.g. "Church friend",
-- "Probate administrator") that replaces the generic "Other" display pill
-- everywhere the contact is rendered. Null for any non-other kind.

alter table public.contacts add column if not exists kind_other text;

comment on column public.contacts.kind_other is
  'Free-text label used when kind = ''other''. When set, UI displays this in place of the generic Other pill. Null for any non-other kind.';
