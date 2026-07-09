-- Online quote acceptance + Zoho invoicing (two-invoice pattern: a £deposit VAT
-- invoice raised at accept time, a balance invoice raised pre-move). Additive
-- only — safe to apply over live data.
--
-- Idempotency contract (VAT liability — an invoice must NEVER be created twice):
-- zoho_*_invoice_id doubles as the creation claim. A creator first flips it from
-- NULL to 'pending' with a conditional update (only one caller can win), then
-- creates in Zoho, then writes the real id. Losers see non-NULL and stop.

alter table quotes
  add column if not exists accept_token                 text,
  add column if not exists accepted_name                text,
  add column if not exists accepted_ip                  text,
  add column if not exists deposit_amount               numeric(10,2),
  add column if not exists deposit_paid_at              timestamptz,
  add column if not exists deposit_paid_method          text,
  add column if not exists zoho_contact_id              text,
  add column if not exists zoho_deposit_invoice_id      text,
  add column if not exists zoho_deposit_invoice_number  text,
  add column if not exists zoho_deposit_invoice_url     text,
  add column if not exists zoho_deposit_error           text,
  add column if not exists zoho_balance_invoice_id      text,
  add column if not exists zoho_balance_invoice_number  text,
  add column if not exists zoho_balance_invoice_url     text,
  add column if not exists balance_invoice_amount       numeric(10,2),
  add column if not exists balance_invoice_created_at   timestamptz;

create unique index if not exists quotes_accept_token_uq
  on quotes(accept_token) where accept_token is not null;
