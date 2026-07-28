-- 0078: refund → Zoho VAT reversal (go-live checklist C8; Peter, 2026-07-28).
-- When a card refund/void reverses the output VAT on a deposit, the panel now
-- raises a Zoho credit note and records its refund automatically. Store the
-- credit-note id + number on the card_payment for idempotency (never create
-- twice), audit, and the accounts@ verify email reference. Written by the
-- service role only (the refund flow runs on the admin client); no RLS change
-- needed — office read of card_payments already returns these columns.
alter table card_payments add column if not exists zoho_credit_note_id text;
alter table card_payments add column if not exists zoho_credit_note_number text;
