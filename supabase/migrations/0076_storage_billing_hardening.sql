-- 0076: Storage Billing v2 hardening (2026-07-22 three-lens review, pre-go-live).
-- Companion code changes land in the same commit; see docs/storage-billing-v2-prd.md §8.

-- 1) storage_handling_events: drop the office UPDATE policy. The app has NO
--    update path for events (insert + delete only), so the policy was pure
--    attack surface — any office JWT could rewrite amount/billed_invoice_id on
--    billed rows via PostgREST with no audit trail (un-billing = double-charge
--    on the next sweep; fake-billing = hidden waiver). The billing core marks
--    events billed via the service role, which bypasses RLS — nothing breaks.
drop policy if exists storage_handling_events_update on storage_handling_events;

-- 2) Align DELETE with reality: office users record events, so office users
--    may remove them — but ONLY while unbilled. Row-level predicate makes the
--    "delete vs concurrent billing" race safe at the DB: once billed_invoice_id
--    lands, the row no longer matches and the delete affects 0 rows.
drop policy if exists storage_handling_events_delete on storage_handling_events;
create policy storage_handling_events_delete on storage_handling_events
  for delete using (is_office() and billed_invoice_id is null);

-- 3) Pin authorship and positivity at the DB — zod only guards the app path;
--    a direct PostgREST insert could spoof created_by or inject a negative
--    amount (a disguised discount the engine would happily sum).
drop policy if exists storage_handling_events_insert on storage_handling_events;
create policy storage_handling_events_insert on storage_handling_events
  for insert with check (is_office() and created_by = auth.uid());
alter table storage_handling_events drop constraint if exists storage_handling_events_amount_positive;
alter table storage_handling_events add constraint storage_handling_events_amount_positive check (amount > 0);

-- 4) Money-column sanity on lets/invoices.
alter table storage_lets drop constraint if exists storage_lets_min_days_check;
alter table storage_lets add constraint storage_lets_min_days_check check (min_days is null or min_days >= 1);
alter table storage_lets drop constraint if exists storage_lets_min_amount_check;
alter table storage_lets add constraint storage_lets_min_amount_check check (min_amount is null or min_amount >= 0);
alter table storage_invoices drop constraint if exists storage_invoices_handling_amount_check;
alter table storage_invoices add constraint storage_invoices_handling_amount_check check (handling_amount >= 0);

-- 5) Record WHICH events a claim sweeps (uuid[]) so the write-back and the
--    pending-claim repair mark exactly the claimed set — never a recomputed
--    one that could include events recorded after the claim (the crash-retry
--    divergence class).
alter table storage_invoices add column if not exists handling_event_ids uuid[] not null default '{}';

-- 6) Supplier costs (what Marley pays Sandys) move out of business_settings —
--    business_settings SELECT is is_office() (admin + estimator), and supplier
--    costs/margin are admin-only. Singleton table, admin-only RLS; the app
--    reads it with the user client so non-admins simply get no row.
create table if not exists storage_supplier_rates (
  id         boolean primary key default true check (id),
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table storage_supplier_rates enable row level security;
drop policy if exists storage_supplier_rates_read on storage_supplier_rates;
create policy storage_supplier_rates_read on storage_supplier_rates for select using (is_admin());
drop policy if exists storage_supplier_rates_write on storage_supplier_rates;
create policy storage_supplier_rates_write on storage_supplier_rates for all using (is_admin()) with check (is_admin());

insert into storage_supplier_rates (id, data)
select true, coalesce(bs.storage_rates->'supplier', '{}'::jsonb)
from business_settings bs
where bs.id = true
on conflict (id) do nothing;

update business_settings
set storage_rates = storage_rates - 'supplier'
where id = true and storage_rates ? 'supplier';

-- 7) Signature evidence: the crate ack wording renders LIVE figures from the
--    rate card, so booleans alone can't prove what was on screen at signing.
--    Store the rendered labels alongside.
alter table signatures add column if not exists ack_labels jsonb;

-- 8) storage_invoices: drop office INSERT/UPDATE (0027 granted both). Claims
--    are engine-authored via the service role only — the app never writes this
--    table with a user client. An office JWT inserting a fake claim row makes
--    the engine treat the period as billed forever (hidden waiver), and
--    PATCHing handling_event_ids/status/amount on a pending claim corrupts the
--    repair sweep that now trusts those columns — the same tamper class item 1
--    closed on the events table. SELECT stays office; DELETE stays is_admin.
drop policy if exists storage_invoices_insert on storage_invoices;
drop policy if exists storage_invoices_update on storage_invoices;
