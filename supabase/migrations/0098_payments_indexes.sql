-- /payments query coverage. Every filter below runs on the DEFAULT tab of the
-- money page, and each targets a table that grows forever with trading volume
-- (every quote, lead, card attempt and bank row the business ever takes). The
-- tables are small today, so these are free to add now and stop a slow page
-- being discovered as an incident later.
--
-- Partial (WHERE ... IS NOT NULL) because the queries are always range filters
-- on the timestamp, so rows that were never paid/settled/matched carry no
-- information for them and needn't be indexed.

-- received-tab: deposits/commitments marked paid inside the viewed range.
create index if not exists quotes_deposit_paid_at_idx
  on quotes (deposit_paid_at) where deposit_paid_at is not null;
create index if not exists quotes_commitment_paid_at_idx
  on quotes (commitment_paid_at) where commitment_paid_at is not null;

-- received-tab: balances marked paid inside the viewed range.
create index if not exists leads_balance_paid_at_idx
  on leads (balance_paid_at) where balance_paid_at is not null;

-- received-tab: card receipts + refunds inside the viewed range (an OR of two
-- independent range filters, so each column needs its own index).
create index if not exists card_payments_settled_at_idx
  on card_payments (settled_at) where settled_at is not null;
create index if not exists card_payments_refunded_at_idx
  on card_payments (refunded_at) where refunded_at is not null;

-- received-tab: the arrival-day suppression lookup, which asks "does a bank
-- match exist for these quotes?" with NO date bound — the one query here that
-- nothing else constrains, so it needs the index most. Also serves the new
-- "does another transfer already explain this payment?" duplicate check.
create index if not exists bank_transactions_matched_quote_idx
  on bank_transactions (matched_quote_id) where matched_quote_id is not null;

-- 'duplicate': a transfer for a payment that is already recorded AND already
-- has a bank row against it — i.e. the customer appears to have paid twice.
-- It is parked in the "needs a human" queue rather than auto-reconciled,
-- because reconciling would file a refund we owe as money already explained
-- and it would vanish from every queue, the exceptions strip and the ledger.
alter table bank_transactions
  drop constraint if exists bank_transactions_match_confidence_check;
alter table bank_transactions
  add constraint bank_transactions_match_confidence_check
  check (match_confidence in ('reference', 'amount', 'manual', 'duplicate'));
