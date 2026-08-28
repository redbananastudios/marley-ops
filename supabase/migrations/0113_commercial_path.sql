-- 0113: Commercial path — the completion invoice and its terms (multi-brand PRD §3.10, gate 10).
--
-- Gate 8 (0111) laid the rails: clients.payment_terms_days, and the
-- quotes.payment_policy snapshot taken at acceptance. This adds the two columns
-- the commercial LADDER itself needs, and nothing else.
--
-- Residential behaviour is untouched. Both columns are null on every existing
-- row and are read only when quotes.payment_policy = 'commercial', which no
-- live row carries (0111 backfilled every accepted quote to 'residential', and
-- the prod pre-flight recorded there confirmed zero clients carry is_company).
--
-- ## Why the completion invoice reuses the BALANCE columns
--
-- It is not given its own zoho_*/-suffix set. `-BAL` is the LAST invoice on a
-- job either way, so reusing zoho_balance_invoice_id / _number / _url and
-- balance_invoice_amount keeps /finance, the bank-feed matcher, the ledger
-- adapter and the five-value match_kind set working with no new suffix and no
-- new kind (PRD §10 Identifiers: "no new suffix"). What differs between the two
-- policies is only WHEN the invoice is raised (job completion, not T-7) and
-- when it falls due — which is exactly what commercial_due_date carries.
--
-- Adding a parallel set of invoice columns would have doubled every read that
-- asks "what is outstanding on this job", and every one of them would have been
-- a place to forget the second set.

-- --------------------------------------------------------------------- quotes

-- When the completion invoice falls due: the day it was raised plus the
-- client's terms, computed by paymentTermsDueDate() in lib/payments-policy.ts
-- and FROZEN here. Frozen rather than derived on read for the same reason the
-- policy itself is snapshotted: editing the client's terms later must not
-- silently re-date an invoice the customer is already holding.
--
-- A DATE, not a timestamptz: this is the date printed on an invoice and the one
-- the office reads on /bookings, so it must mean the same UK calendar day
-- however the server clock is set. The rest of the ladder's day maths
-- (commitment_due_date) uses the same type for the same reason.
alter table public.quotes
  add column commercial_due_date date;

comment on column public.quotes.commercial_due_date is
  'Commercial only: the UK calendar day the completion invoice falls due (raised-on + clients.payment_terms_days), frozen when the invoice is raised. Null for residential, and null on a commercial job that is not yet invoiced. Past this date the booking is internally overdue — a commercial customer is NEVER chased by email (PRD §3.10).';

-- The customer's own purchase-order reference, printed on the invoice when
-- present. Optional by design and never blocking: a commercial booking is
-- confirmed by the office, and refusing to confirm one because a PO has not
-- been issued yet would put a real job on hold for paperwork.
alter table public.quotes
  add column po_number text
  constraint quotes_po_number_len check (po_number is null or char_length(po_number) <= 64);

comment on column public.quotes.po_number is
  'Optional customer purchase-order reference for a commercial booking. Printed on the invoice when present; never required, and never blocks confirmation.';

-- Reading the commercial queues means "every accepted commercial quote", which
-- is a small slice of a table that is mostly residential. A partial index keeps
-- that read off a sequential scan without carrying the residential rows.
create index if not exists quotes_commercial_open_idx
  on public.quotes (commercial_due_date)
  where payment_policy = 'commercial';
