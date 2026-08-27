-- 0110: enforce the ledger-provider stamp added by 0109.
--
-- **APPLY THIS AFTER THE DEPLOY, NOT BEFORE IT.** This is the one migration in
-- the repo whose ordering is the reverse of the house rule, and getting it
-- backwards is not a subtle failure.
--
-- The usual rule — migration first, then merge — exists because a deploy must
-- never query a column that does not exist. A CONSTRAINT inverts that: the code
-- currently running does not yet write the stamp, so a constraint applied ahead
-- of the deploy rejects EVERY invoice raise until the new containers are up.
-- On staging (2026-08-27) that window was long enough for the e2e seed to die
-- on the first deposit invoice it tried to raise, with a check-constraint error
-- that reads like a bug in the seed rather than a sequencing mistake.
--
-- Order, for prod and for any future environment:
--   1. apply 0109 (columns + backfill) — safe at any time, purely additive
--   2. deploy the code that writes the stamps
--   3. apply this file
--   4. notify pgrst, 'reload schema'
--
-- ## What the constraints actually buy
--
-- A stored id says nothing about which system issued it, and `LEDGER_PROVIDER`
-- is a single global switch. Without a stamp, the flip sends every Zoho id to
-- Xero; the not-found reads as transient, a customer who HAS paid is never
-- marked paid, and the poller keeps reporting healthy runs while the chase
-- emails go out. The stamp prevents that only if it is always present — and
-- "always" has to be enforced by the database, because the alternative is
-- remembering it at six write sites forever.
--
-- The literal 'pending' is tolerated because it is the creation CLAIM, not an
-- id: the row holds it for the few seconds between claiming the slot and the
-- provider answering. The claim writes its provider anyway, so this clause
-- covers a half-written future claim rather than an expected state.

alter table quotes
  add constraint quotes_deposit_invoice_provider_ck
    check (ledger_provider_ok(deposit_invoice_provider)
           and (zoho_deposit_invoice_id is null
                or zoho_deposit_invoice_id = 'pending'
                or deposit_invoice_provider is not null)),
  add constraint quotes_commitment_invoice_provider_ck
    check (ledger_provider_ok(commitment_invoice_provider)
           and (zoho_commitment_invoice_id is null
                or zoho_commitment_invoice_id = 'pending'
                or commitment_invoice_provider is not null)),
  add constraint quotes_balance_invoice_provider_ck
    check (ledger_provider_ok(balance_invoice_provider)
           and (zoho_balance_invoice_id is null
                or zoho_balance_invoice_id = 'pending'
                or balance_invoice_provider is not null)),
  add constraint quotes_contact_provider_ck
    check (ledger_provider_ok(contact_provider)
           and (zoho_contact_id is null
                or zoho_contact_id = 'pending'
                or contact_provider is not null));

alter table storage_invoices
  add constraint storage_invoices_invoice_provider_ck
    check (ledger_provider_ok(invoice_provider)
           and (zoho_invoice_id is null or invoice_provider is not null));

alter table card_payments
  add constraint card_payments_credit_note_provider_ck
    check (ledger_provider_ok(credit_note_provider)
           and (zoho_credit_note_id is null or credit_note_provider is not null));
