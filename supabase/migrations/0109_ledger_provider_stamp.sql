-- 0109: stamp WHICH ledger minted each stored document id
-- (docs/ledger-adapter-design.md §8 and §12.5, gate 18).
--
-- Every `zoho_*_id` column in this schema records an id but not the system that
-- issued it, because until now there was only one system. `LEDGER_PROVIDER` is a
-- single global switch, so the moment it flips to Xero every stored Zoho id is
-- read against Xero. Best case that throws on every pass forever. Worst case a
-- not-found reads as transient, a customer who HAS paid is never marked paid,
-- and the cron keeps reporting a healthy run while the chase emails go out.
--
-- ## Why the stamp has to be per invoice SLOT, not per quote
--
-- This was not obvious and is the whole reason for six columns rather than one.
-- `ensureCommitmentInvoice` and the T-7 balance raise both mint NEW invoice ids
-- on quotes accepted long before any cutover, so a booking accepted in early
-- September gets its deposit in Zoho and its balance in Xero. A Zoho deposit
-- beside a Xero balance on one quote is the NORMAL state of every live booking
-- crossing the flip, not an edge case. The supersede path makes it worse: it
-- copies an old quote's deposit invoice id AND contact id onto a brand-new
-- quote, so even the quote's own created_at says nothing about its deposit.
--
-- Deriving the provider from a DATE was considered and rejected for the same
-- reason: `quotes` has balance_invoice_created_at and
-- commitment_invoice_created_at but NO deposit_invoice_created_at, and the
-- supersede copy defeats every remaining date. Cheaper than a column, and wrong
-- in exactly the rows that matter.
--
-- ## Why nullable, and why the CHECKs are a SEPARATE migration (0110)
--
-- A `not null default 'zoho'` was rejected: the default is honest for the
-- backfill and becomes a silent lie the first time a write sets an id and
-- forgets the provider, claiming Zoho for a document Xero minted. The CHECKs in
-- 0110 make that write FAIL instead — a failed raise is visible, retryable and
-- already has an error path at every one of these call sites, whereas a
-- mis-stamped invoice is discovered by a customer.
--
-- They are a separate file because of the ORDER they have to be applied in, and
-- this repo's usual rule points the wrong way. Additive columns go on before the
-- code, so the deploy never queries a column that does not exist. A CONSTRAINT
-- is the mirror image: the code already running cannot satisfy it, so applying
-- it first breaks every invoice raise until the deploy catches up. Learned the
-- hard way on staging, 2026-08-27 — the constraints went on ahead of the
-- writers and the e2e seed died on the first deposit invoice it tried to raise.
--
-- So: 0109 (this file) before the deploy, 0110 after it. The prod runbook
-- states that order explicitly rather than leaving it to be re-derived.
--
-- ## Backfill
--
-- Every existing id was minted by Zoho: this migration lands before the adapter
-- can be pointed anywhere else, and prod has never run anything but Zoho. That
-- is a statement about history, not a default for the future — hence a one-off
-- UPDATE rather than a column default.

-- Provider values match `LedgerProvider` in lib/ledger/types.ts. Text plus a
-- check rather than a pg enum: an enum needs its own migration to extend, and
-- this set will grow if the books ever move again.
create or replace function ledger_provider_ok(v text) returns boolean
  language sql immutable parallel safe
as $$ select v is null or v in ('zoho', 'xero') $$;

comment on function ledger_provider_ok(text) is
  'Allowed values for the ledger-provider stamp columns (0109). Mirrors LedgerProvider in lib/ledger/types.ts.';

-- ---------------------------------------------------------------- quotes
-- Four slots, four stamps. `contact_provider` is the sharpest of them: the
-- contact id is handed to createInvoice on all three raise paths, and
-- `isRealZohoId` only tests non-null and <> 'pending' — it has no concept of
-- which provider minted the id. The commitment path self-heals from the
-- customer's own /q page load, so an unstamped contact id would mean a customer
-- refreshing their booking page generates a fresh failed create and a fresh ops
-- alert every time they look at it.
alter table quotes
  add column deposit_invoice_provider    text,
  add column commitment_invoice_provider text,
  add column balance_invoice_provider    text,
  add column contact_provider            text;

update quotes set deposit_invoice_provider    = 'zoho' where zoho_deposit_invoice_id    is not null;
update quotes set commitment_invoice_provider = 'zoho' where zoho_commitment_invoice_id is not null;
update quotes set balance_invoice_provider    = 'zoho' where zoho_balance_invoice_id    is not null;
update quotes set contact_provider            = 'zoho' where zoho_contact_id            is not null;

comment on column quotes.deposit_invoice_provider is
  'Which ledger minted zoho_deposit_invoice_id. Never infer this from a date or from the quote''s own provider — the supersede path copies a deposit id onto a newer quote (0109).';
comment on column quotes.contact_provider is
  'Which ledger minted zoho_contact_id. Read BEFORE handing the id to createInvoice: a Zoho contact id sent to Xero fails every raise, and the commitment path retries it on every customer page load (0109).';

-- ------------------------------------------------------- storage_invoices
-- Storage bills every period, so this table gains new rows continuously across
-- any cutover — the same flow argument that ruled out draining the open set.
alter table storage_invoices add column invoice_provider text;

update storage_invoices set invoice_provider = 'zoho' where zoho_invoice_id is not null;

-- ----------------------------------------------------------- card_payments
-- Credit notes are raised long after the invoice they reverse, so a refund
-- crossing the flip reverses a Zoho invoice with a Xero note. The note id is
-- what refundCreditNote is later called against.
alter table card_payments add column credit_note_provider text;

update card_payments set credit_note_provider = 'zoho' where zoho_credit_note_id is not null;

-- ------------------------------------------------------------ refund_queue
-- `refund_queue.held` is jsonb built by lib/refunds.ts from the quote's invoice
-- slots, so each obligation inside it carries an invoice id copied from a
-- column above. The provider rides along in the same jsonb (no schema change);
-- this comment is the record of that contract, since nothing else in the
-- database describes the shape.
comment on column refund_queue.held is
  'Held-money obligations, jsonb. Each entry carrying a zoho_invoice_id MUST also carry ledger_provider, copied from the quote''s matching *_invoice_provider column — the id alone does not say which system minted it (0109).';
