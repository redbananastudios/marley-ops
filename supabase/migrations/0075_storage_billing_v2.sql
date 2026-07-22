-- 0075: Storage Billing v2 — rate card + crate daily-arrears model + handling
-- events (standing policy, Peter 2026-07-22; docs/storage-billing-v2-prd.md).
--
--  storage_lets      billing_model routes the engine: 'period' = the shipped
--                    in-advance weekly/monthly engine (containers), 'crate_daily'
--                    = 28-day minimum upfront then exact-day arrears on a 28-day
--                    cycle. min_days/min_amount freeze the minimum at let
--                    creation so later rate-card edits never disturb a running
--                    let. rate_period gains 'day' (crate day rate).
--  storage_handling_events  one row per handling event (in/out/access), amount
--                    frozen at record time; billed_invoice_id set when it rides
--                    an invoice. Money table → is_office(), like storage_invoices.
--  storage_invoices  kind + handling_amount (portion of amount that is handling)
--                    for display + monthly Sandys cost reconciliation.
--  business_settings storage_rates jsonb — the editable rate card (customer
--                    gross figures + supplier gross costs, FRS: no input VAT).

alter table storage_lets
  add column if not exists billing_model text not null default 'period'
    check (billing_model in ('period', 'crate_daily')),
  add column if not exists min_days integer,
  add column if not exists min_amount numeric(10,2);

alter table storage_lets drop constraint if exists storage_lets_rate_period_check;
alter table storage_lets
  add constraint storage_lets_rate_period_check
    check (rate_period in ('week', 'month', 'day'));

create table storage_handling_events (
  id                 uuid primary key default gen_random_uuid(),
  let_id             uuid not null references storage_lets(id) on delete restrict,
  client_id          uuid references clients(id) on delete set null,
  event_date         date not null,
  kind               text not null check (kind in ('in', 'out', 'access')),
  amount             numeric(10,2) not null,
  notes              text,
  billed_invoice_id  uuid references storage_invoices(id) on delete set null,
  created_by         uuid references profiles(id),
  created_at         timestamptz not null default now()
);
create index storage_handling_events_let_idx on storage_handling_events(let_id);
create index storage_handling_events_unbilled_idx
  on storage_handling_events(let_id) where billed_invoice_id is null;

alter table storage_handling_events enable row level security;
create policy storage_handling_events_read   on storage_handling_events for select using (is_office());
create policy storage_handling_events_insert on storage_handling_events for insert with check (is_office());
create policy storage_handling_events_update on storage_handling_events for update using (is_office());
create policy storage_handling_events_delete on storage_handling_events for delete using (is_admin());

alter table storage_invoices
  add column if not exists kind text not null default 'period'
    check (kind in ('period', 'minimum', 'arrears', 'final')),
  add column if not exists handling_amount numeric(10,2) not null default 0;

-- The editable rate card. Customer figures VAT-inclusive; supplier costs gross
-- (FRS — no input VAT recovery, the gross column is the real cost).
alter table business_settings
  add column if not exists storage_rates jsonb;

update business_settings set storage_rates = jsonb_build_object(
  'container_month_inc', 348,
  'crate_week_inc', 21,
  'crate_day_inc', 3,
  'crate_min_days', 28,
  'crate_min_inc', 84,
  'handling_event_inc', 72,
  'supplier', jsonb_build_object(
    'container_month_cost', 174,
    'containers_count', 2,
    'crate_day_cost', 1.7143,
    'handling_event_cost', 60
  )
) where id = true and storage_rates is null;
