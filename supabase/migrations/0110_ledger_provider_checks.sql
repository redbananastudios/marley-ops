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

-- ## Close the window before locking it
--
-- 0109 backfills, then the deploy happens, then this file runs — so anything
-- written by the OLD image in between carries an id and no stamp, and the
-- `alter table` below would fail on it. That is the correct behaviour and the
-- worst possible moment for it: mid-promotion, on prod, with a constraint that
-- refuses to apply and no obvious next step.
--
-- So sweep first. Every row this catches was raised by an image that only ever
-- talked to Zoho, which is the same reasoning 0109's backfill rests on. Writing
-- it here rather than telling a human to re-run 0109 keeps the file idempotent:
-- it is safe whether the window was two minutes or two weeks, and safe to
-- re-run after a failure.
--
-- It also catches fixture writers. `scripts/seed-e2e.mjs` and
-- `e2e/office/invoice-resend-lock.spec.ts` set invoice ids directly with the
-- service role, bypassing the app's raise paths entirely — they are writers the
-- stamp rule applies to just as much as accept-flow is, and both were missed
-- until this constraint refused to apply to staging on 2026-08-27. Both now
-- stamp their own rows; this sweep covers any that predate that fix.
update quotes set deposit_invoice_provider    = 'zoho'
  where zoho_deposit_invoice_id    is not null and zoho_deposit_invoice_id    <> 'pending'
    and deposit_invoice_provider    is null;
update quotes set commitment_invoice_provider = 'zoho'
  where zoho_commitment_invoice_id is not null and zoho_commitment_invoice_id <> 'pending'
    and commitment_invoice_provider is null;
update quotes set balance_invoice_provider    = 'zoho'
  where zoho_balance_invoice_id    is not null and zoho_balance_invoice_id    <> 'pending'
    and balance_invoice_provider    is null;
update quotes set contact_provider            = 'zoho'
  where zoho_contact_id            is not null and zoho_contact_id            <> 'pending'
    and contact_provider            is null;
update storage_invoices set invoice_provider  = 'zoho'
  where zoho_invoice_id            is not null and invoice_provider          is null;
update card_payments set credit_note_provider = 'zoho'
  where zoho_credit_note_id        is not null and credit_note_provider      is null;

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
