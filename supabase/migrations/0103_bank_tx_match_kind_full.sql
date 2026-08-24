-- One transfer that pays a whole job.
--
-- The manual link path matches ONE settled item at an exact amount, which
-- leaves a customer who settles a job in a single transfer with nothing the
-- office can pick: their money sits in "Transfers that need a human" forever.
-- Live example: IMV012 was imported already paid with a blanket GBP100 deposit,
-- so its recorded payments are 100 + 560 and the real GBP660 transfer that paid
-- it matched neither. All 17 imported IMV jobs carry that same blanket deposit,
-- so this is a class, not a one-off.
--
-- 'full' means: this transfer explains ALL of the quote's recorded payments.
-- It is only ever written when the transfer equals their sum to the penny, so
-- the amount rule that makes linking safe is unchanged - it is applied to the
-- set instead of to each item.
--
-- Follows 0086's shape for extending this constraint.

alter table public.bank_transactions
  drop constraint if exists bank_transactions_match_kind_check;

alter table public.bank_transactions
  add constraint bank_transactions_match_kind_check
  check (match_kind in ('deposit', 'commitment', 'balance', 'storage', 'full'));
