-- Bank feed (Monzo → Google Sheets export → 2-min poll). Every transaction the
-- export shows us, dedup'd on Monzo's transaction id. Inbound faster payments
-- get matched against awaiting deposits/balances; a HUMAN confirms before
-- anything is recorded (never auto-mark-paid — the confirm runs the existing
-- deposit/balance paid pipeline).
create table if not exists bank_transactions (
  id uuid primary key default gen_random_uuid(),
  transaction_id text not null unique,
  tx_date date not null,
  tx_time text,
  tx_type text,
  counterparty text,
  amount numeric(12,2) not null,
  currency text,
  -- Monzo "Notes and #tags" — where an inbound FPS sender reference lands.
  reference text,
  description text,
  raw jsonb not null default '{}'::jsonb,
  matched_quote_id uuid references quotes(id) on delete set null,
  match_kind text check (match_kind in ('deposit', 'balance', 'storage')),
  match_confidence text check (match_confidence in ('reference', 'amount')),
  -- info      = not an inbound customer payment (outbound, pot transfer, card settlement…)
  -- unmatched = inbound money we couldn't tie to an open invoice
  -- suggested = matched to an open deposit/balance, awaiting the office's confirm
  -- confirmed = office confirmed; the paid pipeline ran
  -- dismissed = office said "not a customer payment / already handled"
  status text not null default 'info'
    check (status in ('info', 'unmatched', 'suggested', 'confirmed', 'dismissed')),
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists bank_transactions_date_idx on bank_transactions (tx_date desc);
create index if not exists bank_transactions_status_idx on bank_transactions (status);

create trigger trg_bank_transactions_updated
  before update on bank_transactions
  for each row execute function set_updated_at();

alter table bank_transactions enable row level security;
-- Office reads; ALL writes stay service-role only (the cron + gated actions).
create policy bank_transactions_read on bank_transactions for select using (is_office());
