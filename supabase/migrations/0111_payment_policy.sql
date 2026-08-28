-- 0111: Payment policy foundation — residential vs commercial (multi-brand PRD §3.10, gate 8).
--
-- Two policies, shared by every brand. `residential` is today's live v2 ladder,
-- unchanged: £100 deposit at acceptance → date confirmed by signature → 25%
-- commitment minus deposit due T-7 → balance at T-7. `commercial` has no
-- deposit, no commitment and no customer chase — one invoice raised on job
-- completion, due on the client's own terms.
--
-- THIS MIGRATION IS INERT FOR LIVE BEHAVIOUR. It lays the rails only: the
-- commercial path itself is gate 10. Verified against prod before writing
-- (2026-08-28): zero clients carry is_company, so repurposing the flag moves
-- nobody onto post-pay terms. That count is the PRD's blocking pre-flight.
--
-- Why the policy is SNAPSHOTTED onto the quote rather than read live from the
-- client: a client's type is editable forever, and re-reading it would let an
-- edit months later silently re-write the payment schedule of a booking that is
-- already in flight — including one whose deposit has been taken. The snapshot
-- is written once, at acceptance, and never re-derived.

-- ---------------------------------------------------------------- clients

-- Commercial payment terms. Meaningful only when is_company is true; carried on
-- every client so the column is never null and readers need no fallback. 30 and
-- 60 are the only values the office can pick (PRD §3.10) — the check constraint
-- is what stops a stray 45 reaching an invoice due-date calculation.
alter table public.clients
  add column payment_terms_days integer not null default 30
  constraint clients_payment_terms_days_valid check (payment_terms_days in (30, 60));

comment on column public.clients.payment_terms_days is
  'Commercial payment terms in days (30 default, 60 selectable). Applies to removals AND storage invoices. Ignored for residential clients, which pay on the deposit/commitment/balance ladder.';

comment on column public.clients.is_company is
  'Residential (false) vs commercial (true). Since gate 8 this drives the payment policy snapshotted onto a quote at acceptance, not just which display name is used — flipping it changes how NEW bookings for this client are invoiced and chased. In-flight bookings are unaffected: they carry their own snapshot in quotes.payment_policy.';

-- ----------------------------------------------------------------- quotes

-- The snapshot. Null until acceptance, which is the moment it is taken; a
-- non-null value is therefore also the marker that this quote's schedule is
-- fixed. Deliberately NOT defaulted: a default would make every draft look
-- already-snapshotted and hide the acceptance write.
alter table public.quotes
  add column payment_policy text
  constraint quotes_payment_policy_valid check (payment_policy in ('residential', 'commercial'));

comment on column public.quotes.payment_policy is
  'Payment policy snapshotted from the client at ACCEPTANCE (never re-derived). Null on an unaccepted quote. residential = deposit/commitment/balance ladder; commercial = single invoice on completion, due on the client terms captured at the same moment.';

-- Every already-accepted quote ran the residential ladder, so that is what its
-- snapshot must say. Restricted to accepted rows on purpose: an unaccepted quote
-- has not been snapshotted yet and must take its policy from the client when it
-- is accepted, not from a backfill written today. This changes no behaviour —
-- it records the behaviour these rows already had.
update public.quotes
   set payment_policy = 'residential'
 where accepted_at is not null
   and payment_policy is null;

-- Self-hosted PostgREST caches the schema; without this the new columns are
-- invisible to the API while the SQL is provably correct.
notify pgrst, 'reload schema';
