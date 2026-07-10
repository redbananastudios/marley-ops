-- 0027: storage billing phase 2 + the storage agreement (Peter, 2026-07-10:
-- "implement the storage features end to end").
--
--  storage_invoices  one row per billed period per let. OUR daily cron raises
--                    these (never Zoho recurring profiles — the panel stays
--                    the source of truth and billing stops the moment a let
--                    ends). unique(let_id, period_start) is the DB half of
--                    never-create-twice; the Zoho reference number
--                    (MMS-<let>-<period>) is the adoption half.
--                    Pricing table → is_office() like the rest of the money.
--  storage_lets      billing_paused (manual hold), sign_token (remote
--                    agreement signing — /s/<token>, same model as /q).
--  signatures        storage_let_id links kind='storage' agreements (they
--                    have no quote); one agreement per let.

create table storage_invoices (
  id                   uuid primary key default gen_random_uuid(),
  let_id               uuid not null references storage_lets(id) on delete restrict,
  client_id            uuid references clients(id) on delete set null,
  period_start         date not null,
  period_end           date not null,          -- inclusive last day of the billed period
  amount               numeric(10,2) not null,
  zoho_invoice_id      text,
  zoho_invoice_number  text,
  zoho_invoice_url     text,
  status               text not null default 'pending'
                         check (status in ('pending','sent','paid','void','error')),
  emailed_at           timestamptz,
  error                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (let_id, period_start)
);
create index storage_invoices_client_idx on storage_invoices(client_id);
create index storage_invoices_status_idx on storage_invoices(status);
create trigger trg_storage_invoices_updated before update on storage_invoices
  for each row execute function set_updated_at();

alter table storage_invoices enable row level security;
create policy storage_invoices_read   on storage_invoices for select using (is_office());
create policy storage_invoices_insert on storage_invoices for insert with check (is_office());
create policy storage_invoices_update on storage_invoices for update using (is_office());
create policy storage_invoices_delete on storage_invoices for delete using (is_admin());

alter table storage_lets
  add column if not exists billing_paused boolean not null default false,
  add column if not exists sign_token text unique;

alter table signatures
  add column if not exists storage_let_id uuid references storage_lets(id) on delete set null;
create unique index if not exists signatures_storage_let_uq
  on signatures(storage_let_id) where kind = 'storage';
