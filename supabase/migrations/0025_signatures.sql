-- 0025: digital signatures (Peter, 2026-07-10 — three signature moments only).
--
--  signatures       one row per signing event. kind='contract' covers the move
--                   contract (remote typed on /q, or drawn in person on the
--                   crew tablet when the crew arrive and it was never
--                   collected). kind='storage' reserved for the storage
--                   agreement (ships with billing phase 2).
--  job_completions  the on-site completion sign-off: customer + crew lead
--                   signatures, exceptions box, customer-absent fallback.
--                   One per appointment, immutable evidence.
--
-- Evidence rows are append-only: no update policies; delete is admin-only
-- (test cleanup). Writes normally happen server-side (service role) because
-- crew are RLS-blocked from quotes but still collect contract signatures.

create table signatures (
  id               uuid primary key default gen_random_uuid(),
  kind             text not null check (kind in ('contract','storage')),
  quote_id         uuid references quotes(id) on delete set null,
  lead_id          uuid references leads(id) on delete set null,
  signer_name      text not null,
  -- PNG data URI when drawn; null when method='typed' (the typed name is the signature).
  signature_data   text,
  method           text not null check (method in ('typed','drawn')),
  channel          text not null check (channel in ('remote','in_person')),
  acknowledgments  jsonb not null default '{}'::jsonb,
  terms_version    text,
  ip               text,
  user_agent       text,
  collected_by     uuid references profiles(id) on delete set null, -- staff member for in_person
  signed_at        timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  constraint signatures_drawn_has_image check (method <> 'drawn' or signature_data is not null)
);

-- One contract signature per quote — the second collector gets a clean conflict.
create unique index signatures_contract_uq on signatures(quote_id) where kind = 'contract';
create index signatures_lead_idx on signatures(lead_id);

create table job_completions (
  id                     uuid primary key default gen_random_uuid(),
  appointment_id         uuid not null unique references appointments(id) on delete cascade,
  lead_id                uuid references leads(id) on delete set null,
  customer_name          text,
  customer_signature     text,          -- PNG data URI; null when customer absent
  customer_absent        boolean not null default false,
  absent_reason          text,
  exceptions             text not null default '',
  crew_staff_id          uuid references staff(id) on delete set null,
  crew_name              text not null,
  crew_signature         text not null, -- PNG data URI
  completed_by           uuid references profiles(id) on delete set null,
  certificate_path       text,          -- storage path of the emailed PDF (job-docs bucket)
  certificate_emailed_at timestamptz,
  signed_at              timestamptz not null default now(),
  created_at             timestamptz not null default now(),
  -- Present customers sign; absent ones need the reason recorded instead.
  constraint job_completions_customer_evidence
    check ((customer_absent and absent_reason is not null) or (not customer_absent and customer_signature is not null))
);

create index job_completions_lead_idx on job_completions(lead_id);

alter table signatures enable row level security;
alter table job_completions enable row level security;

create policy signatures_read        on signatures       for select using (is_staff());
create policy signatures_insert      on signatures       for insert with check (is_staff());
create policy signatures_delete      on signatures       for delete using (is_admin());
create policy job_completions_read   on job_completions  for select using (is_staff());
create policy job_completions_insert on job_completions  for insert with check (is_staff());
create policy job_completions_delete on job_completions  for delete using (is_admin());

-- Private bucket for generated documents (completion certificates).
insert into storage.buckets (id, name, public) values ('job-docs','job-docs', false)
on conflict (id) do nothing;
