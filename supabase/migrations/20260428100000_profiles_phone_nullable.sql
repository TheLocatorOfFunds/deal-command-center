-- profiles.phone — confirm nullable (idempotent).
--
-- Per Nathan 2026-04-28: he reported users couldn't save Account Settings
-- without a phone. The client code already passes phone as NULL when blank,
-- so the most likely cause is a NOT NULL constraint on the column. This
-- migration drops it if present (idempotent — no-op if already nullable).

alter table public.profiles alter column phone drop not null;
