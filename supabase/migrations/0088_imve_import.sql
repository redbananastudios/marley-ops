-- Legacy iMVE import: booked jobs from the old system come across with
-- source='imve' and are HARD-excluded from the panel's money automation —
-- no commitment invoices, no T-10/T-7 ladder, no contract-signature nags.
-- Those customers were sold under iMVE-era terms (no 25%-by-T-7 promise),
-- so every money action on them is a manual trigger Peter fires.
--
-- imve_ref keeps the old system's reference verbatim (it is NOT unique in
-- iMVE — duplicates exist, so quote_ref may carry a -2/-3 suffix while this
-- column holds the raw value). imve_zoho_invoice_number links Connor's
-- pre-existing Zoho draft by reference, display-only — the panel never
-- adopts it into the zoho_* invoice machinery.

alter table quotes add column if not exists source text not null default 'marley_ops';
alter table quotes drop constraint if exists quotes_source_check;
alter table quotes
  add constraint quotes_source_check
  check (source in ('marley_ops', 'imve'));

alter table quotes add column if not exists imve_ref text;
alter table quotes add column if not exists imve_zoho_invoice_number text;

-- Batch stamp for clean rollback of one import run. Only stamped on leads the
-- import created and on clients it CREATED (matched existing clients are never
-- stamped, so rollback can't delete a pre-existing customer).
alter table leads add column if not exists import_batch text;
alter table clients add column if not exists import_batch text;
