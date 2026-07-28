-- 0077: card-payment reconcile hardening (2026-07-28 sandbox verification finding).
-- The gateway's QUERY action polls by `xref` (integration guide), NOT by our
-- `transactionUnique` — and a payment where BOTH the server callback and the
-- browser return failed has no xref, so it can never be queried. Such a row
-- (customer possibly charged, no confirmation) must be ESCALATED to a human to
-- check the takepayments MMS, never silently marked "abandoned"/"not paid".
-- This column dedups that escalation so the reconcile cron alerts once, not
-- every 15-minute tick.
alter table card_payments add column if not exists reconcile_alerted_at timestamptz;
