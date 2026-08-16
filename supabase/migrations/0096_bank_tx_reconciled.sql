-- Bank feed: 'reconciled' — an inbound transfer whose referenced payment was
-- ALREADY recorded through another path (Connor recording it in Zoho → the
-- zoho-deposits poll marks it paid, or an office one-tap mark-paid) before the
-- bank row was processed. The matcher only ever matches against OPEN items, so
-- such a transfer could never match and sat in "Unmatched inbound" forever
-- (Brydee Thomas MMR034's £450 "MMR034-BAL", 2026-08-16). Reconciled rows are
-- linked to their quote but the paid pipeline is NOT run — the money is
-- already on the books; this status only stops recorded money reading as
-- missing money.

alter table bank_transactions
  drop constraint if exists bank_transactions_status_check;
alter table bank_transactions
  add constraint bank_transactions_status_check
  check (status in ('info', 'unmatched', 'suggested', 'confirmed', 'dismissed', 'reconciled'));
