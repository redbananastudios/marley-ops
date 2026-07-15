-- 0043: Card payments via takepayments (Peter, 2026-07-15 — PRD
-- docs/takepayments-card-payments-prd.md). Hosted-Payment-Page deposit
-- payments: one-off SALE only, NO recurring agreements, NO Credentials-on-File,
-- and NO card details stored — the only card data persisted is what the
-- gateway returns for bookkeeping (masked number, scheme, auth code, xref).
--
--  card_payments   the gateway attempt ledger. One row per hand-off to the
--                  HPP; `id` doubles as the gateway `transactionUnique` so
--                  callbacks/returns/reconcile map back atomically. Money
--                  truth stays on quotes.deposit_paid_at (flipped by
--                  markDepositPaid) — this table records how the card attempt
--                  went and holds the xref needed for refunds.
--
-- Status flow: pending → paid | failed | abandoned; paid → refunded /
-- partially_refunded / voided. First writer wins via the status='pending'
-- guard in code.
--
-- Service-role only: RLS enabled with NO policies (crew must never read
-- payment rows; office reads go through trusted server actions).

create table card_payments (
  id                     uuid primary key default gen_random_uuid(),
  quote_id               uuid not null references quotes(id) on delete restrict,
  lead_id                uuid references leads(id) on delete set null,
  client_id              uuid references clients(id) on delete set null,
  kind                   text not null default 'deposit' check (kind in ('deposit', 'balance')),
  amount_pence           integer not null check (amount_pence > 0),
  -- is_test attempts run through the real gateway simulator but MUST NOT touch
  -- the customer/Zoho/confirm pipeline (they run against a real quote token).
  is_test                boolean not null default false,
  status                 text not null default 'pending'
                         check (status in ('pending', 'paid', 'failed', 'abandoned',
                                           'refunded', 'partially_refunded', 'voided',
                                           -- gateway reported success but the amount
                                           -- didn't match what we signed: never auto-
                                           -- confirmed, a human reconciles via the MMS.
                                           'needs_review')),
  gateway_xref           text check (char_length(gateway_xref) <= 128),
  gateway_transaction_id text check (char_length(gateway_transaction_id) <= 128),
  response_code          integer,
  response_message       text check (char_length(response_message) <= 512),
  card_number_mask       text check (char_length(card_number_mask) <= 32),
  card_scheme            text check (char_length(card_scheme) <= 64),
  authorisation_code     text check (char_length(authorisation_code) <= 64),
  refunded_pence         integer not null default 0 check (refunded_pence >= 0),
  refund_reason          text check (char_length(refund_reason) <= 512),
  refunded_by            uuid references profiles(id) on delete set null,
  created_at             timestamptz not null default now(),
  settled_at             timestamptz,
  refunded_at            timestamptz
);

-- One live pending attempt per quote — a retry first marks the old row failed.
create unique index card_payments_one_pending_per_quote
  on card_payments (quote_id) where (status = 'pending');

create index card_payments_quote_idx on card_payments (quote_id, created_at desc);
create index card_payments_lead_idx on card_payments (lead_id) where (lead_id is not null);
create index card_payments_pending_idx on card_payments (created_at) where (status = 'pending');

alter table card_payments enable row level security;

-- Kill switch (mirrors the push pattern): OFF by default — the /q card button
-- only renders once env creds exist AND an admin flips this on in Settings.
alter table business_settings
  add column card_payments_enabled boolean not null default false;
