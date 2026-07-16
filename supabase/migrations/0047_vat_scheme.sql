-- VAT scheme for the Finance page's "owed to HMRC" figures.
--  standard  = owe output VAT (20% element of gross) minus input VAT (accountant's side)
--  flat_rate = Flat Rate Scheme: owe flat_rate_pct × VAT-INCLUSIVE turnover;
--              invoices still CHARGE 20% — only the liability calc changes.
alter table business_settings
  add column if not exists vat_scheme text not null default 'standard'
    check (vat_scheme in ('standard', 'flat_rate')),
  add column if not exists vat_flat_rate_pct numeric(4,2) not null default 10;

-- MarleyMoves Ltd is on the Flat Rate Scheme at 10% (transport/removals sector
-- rate — Peter, 2026-07-16). Encode the fact for the singleton row.
update business_settings set vat_scheme = 'flat_rate', vat_flat_rate_pct = 10 where id = true;
