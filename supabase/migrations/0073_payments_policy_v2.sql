-- 0073: Payments Policy v2 — deposit commitment ladder + refund queue
-- (Peter + Connor, 2026-07-21 — docs/payments-policy-v2-prd.md). Additive only.
--
-- The policy in one breath: deposit stays fully refundable until the customer
-- CONFIRMS their move date; confirmation raises a second "commitment" invoice
-- (25% of gross minus the deposit) due 7 days before the move; cancellations /
-- inside-window date changes park the held money in a human-decided refund
-- queue ("did the old day re-book?"). No version gating — the system is
-- pre-launch, so this IS the policy.

-- ---------------------------------------------------------------- 1) leads
-- Date-confirmation flag. Deposit refundability is DERIVED from this stamp
-- (null = still refundable) — deliberately no boolean to drift. The signature
-- id anchors the evidence row (kind='date_confirm', added below).
alter table public.leads
  add column if not exists date_confirmed_at timestamptz,
  add column if not exists date_confirm_signature_id uuid references public.signatures(id) on delete set null;

comment on column public.leads.date_confirmed_at is
  'When the customer confirmed their move date (tick + signature). Null = deposit still fully refundable.';
comment on column public.leads.date_confirm_signature_id is
  'The signatures row (kind=date_confirm) recorded at confirmation — the evidence pack for non-refundability.';

-- --------------------------------------------------------------- 2) quotes
-- Commitment invoice columns — mirror the -DEP/-BAL pattern exactly:
-- zoho_commitment_invoice_id doubles as the never-create-twice claim
-- (NULL → 'pending' → real id), reference suffix -COM, orphan adoption via
-- findInvoiceByReference, release-on-failure into zoho_commitment_error.
alter table public.quotes
  add column if not exists zoho_commitment_invoice_id text,
  add column if not exists zoho_commitment_invoice_number text,
  add column if not exists zoho_commitment_invoice_url text,
  add column if not exists zoho_commitment_error text,
  -- Frozen at raise time (25% x gross - deposit at that moment) so a later
  -- price edit can never silently change what the customer was invoiced.
  add column if not exists commitment_invoice_amount numeric(10,2),
  add column if not exists commitment_invoice_created_at timestamptz,
  -- Due date per policy: move - 7d, clamped to today on late confirmation.
  -- Recomputed on an outside-window date change (the invoice rolls with it).
  add column if not exists commitment_due_date date,
  add column if not exists commitment_paid_at timestamptz,
  add column if not exists commitment_paid_method text,
  -- Chase-cron idempotency stamp: T-10 call task + chase email sent once,
  -- stamped only AFTER the send succeeds (record-after-delivery rule).
  add column if not exists commitment_chase_t10_at timestamptz,
  -- T-7 discretion marker: commitment still unpaid at move - 7d. Surfaces the
  -- "Dates at risk" needs-action card. NEVER an automatic release — releasing
  -- the date is a manual cancel with the standard customer-cancel treatment.
  add column if not exists date_releasable_at timestamptz;

comment on column public.quotes.zoho_commitment_invoice_id is
  'Zoho invoice id for the 25%-minus-deposit commitment invoice (ref <quoteRef>-COM). Doubles as the create-once claim: NULL -> pending -> id.';
comment on column public.quotes.commitment_invoice_amount is
  'Commitment amount frozen when the invoice was raised (25% x gross - deposit at that moment).';
comment on column public.quotes.commitment_due_date is
  'When the commitment falls due: move date - 7 days, clamped to the raise day on late confirmation.';
comment on column public.quotes.commitment_chase_t10_at is
  'T-10 commitment chase sent (idempotency stamp — set only after a successful send).';
comment on column public.quotes.date_releasable_at is
  'Stamped at move-7d if the commitment is still unpaid. A discretion flag for the office, never an automatic release.';

-- ----------------------------------------------------------- 3) signatures
-- Widen the closed-world kind CHECK to admit the date-confirmation signature.
-- The check was declared inline on the column in 0025, so it carries the
-- auto-generated name signatures_kind_check — drop + re-add is the only way
-- to widen it.
alter table public.signatures drop constraint if exists signatures_kind_check;
alter table public.signatures add constraint signatures_kind_check
  check (kind in ('contract', 'storage', 'date_confirm'));

-- One date-confirmation signature per quote — a double submit (two tabs, a
-- replay) gets a clean 23505 the flow treats as success, exactly like the
-- contract signature's signatures_contract_uq.
create unique index if not exists signatures_date_confirm_uq
  on public.signatures (quote_id)
  where kind = 'date_confirm';

-- --------------------------------------------------------- 4) refund_queue
-- Held-money decisions after a cancel / inside-window date change. One row per
-- trigger event; the row is a durable money record: the `held` snapshot is
-- captured AT cancel time (card_payments net-of-refunds + recorded deposit /
-- commitment / balance stamps) so later edits can't rewrite history.
--
-- Human loop: conditional rows ask "did we re-book <original_move_date>?"
-- (determination filled/not_filled — Connor answers from his own diary; no
-- automatic fill detection by design). marley_cancel rows skip determination
-- and refund everything. Nothing is ever refunded/retained without an explicit
-- button press recorded in executed_by/executed_at.
create table public.refund_queue (
  id                     uuid primary key default gen_random_uuid(),
  created_at             timestamptz not null default now(),
  -- Anchors. lead/appointments soften to null if ever purged; quote_id
  -- RESTRICTs like card_payments — a quote with money history can't vanish.
  lead_id                uuid references public.leads(id) on delete set null,
  quote_id               uuid references public.quotes(id) on delete restrict,
  old_appointment_id     uuid references public.appointments(id) on delete set null,
  new_appointment_id     uuid references public.appointments(id) on delete set null,
  -- The date the fill question is about ("did we re-book THIS day?").
  original_move_date     date,
  trigger                text not null check (trigger in
                           ('customer_cancel', 'customer_date_change', 'marley_cancel')),
  -- Snapshot of everything held when the row was created:
  -- [{rail:'card'|'bank_transfer'|'cash', amount, at, label?,
  --   card_payment_id?, zoho_invoice_id?}] — amounts in GBP gross.
  held                   jsonb not null default '[]'::jsonb,
  -- The chronological-first-in split at 25% of gross: conditional is retained
  -- only if the old day stays empty; unconditional is refunded regardless.
  conditional_amount     numeric(10,2) not null default 0,
  unconditional_amount   numeric(10,2) not null default 0,
  -- Null until the human answers the fill question. Pre-set on rows that never
  -- need it (pre-confirmation cancels); marley_cancel rows skip it entirely.
  determination          text check (determination in ('filled', 'not_filled')),
  determined_by          uuid references public.profiles(id) on delete set null,
  determined_at          timestamptz,
  status                 text not null default 'pending'
                         check (status in ('pending', 'refunded', 'retained')),
  executed_by            uuid references public.profiles(id) on delete set null,
  executed_at            timestamptz,
  -- Rebook forfeit trail: when a rebooked job's old day dies unfilled, the
  -- retained amount stops counting toward the new booking — this states the
  -- shortfall for the manual balance adjustment (no automated re-invoice).
  shortfall_note         text,
  -- Cash refunds return by bank transfer to a named account collected on the
  -- row before "Mark refunded" (the Monzo export carries no account numbers,
  -- so bank-rail refunds are keyed off the original payment reference instead).
  cash_recipient_name    text,
  cash_recipient_sort    text,
  cash_recipient_account text,
  notes                  text
);

-- The /refunds page reads pending-first, newest-first; lead pages show a
-- lead's refund history.
create index refund_queue_status_idx on public.refund_queue (status, created_at desc);
create index refund_queue_lead_idx on public.refund_queue (lead_id) where (lead_id is not null);

alter table public.refund_queue enable row level security;

-- Office can SEE the queue; every write goes through trusted server actions on
-- the service role (which bypasses RLS) with office gates in code — mirrors
-- the card_payments pattern. No insert/update/delete policies on purpose:
-- crew/estimator sessions get zero write surface even if a client leaks.
create policy refund_queue_read on public.refund_queue
  for select using (is_office());
