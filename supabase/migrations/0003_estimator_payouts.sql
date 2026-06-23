-- Estimator monthly payouts — records that a month's visit fees have been settled,
-- so Connor can mark Luke paid and see outstanding vs paid. One row per
-- (estimator, month); the figures are snapshotted at mark-paid time.

create table if not exists estimator_payouts (
  id            uuid primary key default gen_random_uuid(),
  estimator_id  uuid not null references profiles(id),
  period_month  date not null,                 -- first day of the month
  visits        int not null default 0,
  amount        numeric(10,2) not null default 0,
  paid_at       timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (estimator_id, period_month)
);

create index if not exists estimator_payouts_idx on estimator_payouts(estimator_id, period_month);

alter table estimator_payouts enable row level security;
create policy estimator_payouts_read   on estimator_payouts for select using (is_staff());
create policy estimator_payouts_insert on estimator_payouts for insert with check (is_admin());
create policy estimator_payouts_update on estimator_payouts for update using (is_admin());
create policy estimator_payouts_delete on estimator_payouts for delete using (is_admin());
