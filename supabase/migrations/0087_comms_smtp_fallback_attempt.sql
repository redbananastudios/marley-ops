-- SMTP fallback one-shot guard: the IONOS transport has no idempotency key,
-- so a communication row may attempt SMTP at most ONCE ever. runProviderSend
-- CAS-claims this column (null -> now()) before dialling; a re-driven row
-- whose claim finds it already set never dials again.

alter table communications
  add column if not exists smtp_fallback_attempted_at timestamptz;
