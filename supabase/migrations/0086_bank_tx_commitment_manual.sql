-- Bank feed: commitment invoices become matchable, and the office can
-- manually attach a transfer to a quote (match_confidence 'manual').
-- Widens the two CHECK constraints from 0048; existing data is a strict
-- subset of the new sets, so this cannot fail on live rows.

alter table bank_transactions
  drop constraint if exists bank_transactions_match_kind_check;
alter table bank_transactions
  add constraint bank_transactions_match_kind_check
  check (match_kind in ('deposit', 'commitment', 'balance', 'storage'));

alter table bank_transactions
  drop constraint if exists bank_transactions_match_confidence_check;
alter table bank_transactions
  add constraint bank_transactions_match_confidence_check
  check (match_confidence in ('reference', 'amount', 'manual'));
