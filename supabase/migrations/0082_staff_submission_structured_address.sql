-- 0082: structured home address on crew sign-up submissions (Peter, 2026-07-30).
-- The public /join form now captures street / town / postcode separately via
-- Google lookup; `address` keeps the formatted one-line string for display and
-- for the approve->staff copy. Additive, no backfill (queue empty pre-launch).

alter table staff_submissions
  add column if not exists address_line1 text,
  add column if not exists address_town text,
  add column if not exists address_county text,
  add column if not exists address_postcode text,
  add column if not exists address_country text;

notify pgrst, 'reload schema';
