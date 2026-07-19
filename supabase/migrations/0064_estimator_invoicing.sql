-- 0064: estimator invoicing (Peter, 2026-07-19).
--
-- Estimators self-submit weekly invoices exactly like crew, reusing the same
-- staff_statements machinery anchored to the estimator's own staff row (Luke has
-- a profile-linked active staff row). What differs is WHAT they bill: not hours,
-- but three fixed-fee events —
--   survey      £50 per attended survey visit (business_settings.estimator_fee)
--   phone_quote £10 per telephone quote where they did NOT attend a survey
--   commission  7.5% of the job value EX-VAT, on COMPLETION (never at deposit —
--               so a cancelled job never earns commission and there is nothing to
--               claw back from the estimator).
--
-- No weekly guarantee (that is a crew-only floor). No VAT (estimators self-
-- employed, not VAT-registered) — same plain contractor-invoice as crew.

-- Allow the three estimator line sources alongside the crew ones.
alter table public.staff_statement_lines drop constraint if exists staff_statement_lines_source_check;
alter table public.staff_statement_lines
  add constraint staff_statement_lines_source_check
  check (source in ('manual', 'job', 'retainer', 'guarantee', 'survey', 'phone_quote', 'commission'));

-- Estimator pay rates (the £50 survey fee already exists as estimator_fee).
alter table public.business_settings
  add column if not exists estimator_phone_quote_fee numeric(10, 2) not null default 10,
  add column if not exists estimator_commission_pct  numeric(10, 2) not null default 7.5;
