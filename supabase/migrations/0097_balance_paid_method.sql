-- How the final balance was paid. markBalancePaid has always RECEIVED the
-- method (bank_transfer | cash) but only forwarded it to Zoho's payment
-- record — nothing persisted it locally, so /payments could never show the
-- rail on a balance the way it can for deposits (0017 deposit_paid_method)
-- and commitments (0073 commitment_paid_method). Same convention: plain text,
-- written by the paid pipeline only.

alter table leads
  add column if not exists balance_paid_method text;
