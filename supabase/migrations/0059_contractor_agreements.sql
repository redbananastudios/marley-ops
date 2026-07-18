-- 0059: contractor agreements (2026-07-18). Each self-employed worker (crew,
-- estimator) signs the contractor agreement ONCE in their own portal before they
-- can use contractor invoicing. The signature is both the per-user go-live gate
-- and the IR35 evidence (the worker confirms their own self-employed status).
-- One row per user per agreement version — a reworded (e.g. accountant-reviewed)
-- version bumps CONTRACTOR_AGREEMENT_VERSION and everyone re-signs. Append-only
-- evidence: a worker can insert + read their own; the office reads all (for the
-- Documents register) and is the only role that can correct a row.
create table public.contractor_agreements (
  id                uuid primary key default gen_random_uuid(),
  profile_id        uuid not null references public.profiles(id) on delete restrict,
  staff_id          uuid references public.staff(id) on delete set null,
  role              text not null,
  agreement_version text not null,
  signer_name       text not null,
  signature_data    text,               -- data-URI PNG of the typed-name signature (like signatures.signature_data)
  acknowledgments   jsonb not null default '{}'::jsonb,
  ip                text,
  user_agent        text,
  signed_at         timestamptz not null default now(),
  created_at        timestamptz not null default now()
);
-- One signature per person per version (replay = clean success).
create unique index contractor_agreements_one_per_version
  on public.contractor_agreements (profile_id, agreement_version);
create index contractor_agreements_profile_idx on public.contractor_agreements (profile_id);

-- A stored agreement must have EVERY acknowledgment ticked. The app enforces this
-- too (allContractorAcksConfirmed), but the CHECK is the backstop so a row that
-- exists is real evidence — a direct-PostgREST insert with empty/partial acks
-- can't create a "signed" row that would satisfy the invoicing gate. Update this
-- constraint whenever CONTRACTOR_ACKS changes.
alter table public.contractor_agreements
  add constraint contractor_agreements_acks_complete check (
    (acknowledgments->>'self_employed')::boolean is true
    and (acknowledgments->>'own_tax')::boolean is true
    and (acknowledgments->>'no_vat')::boolean is true
    and (acknowledgments->>'own_invoices')::boolean is true
    and (acknowledgments->>'no_employee_rights')::boolean is true
  );

alter table public.contractor_agreements enable row level security;

-- Read: office (Documents register) or your own.
create policy contractor_agreements_read on public.contractor_agreements for select
  using (is_office() or profile_id = auth.uid());

-- Insert: only as yourself (you sign your own agreement). profiles.id = auth.uid().
create policy contractor_agreements_insert on public.contractor_agreements for insert
  with check (profile_id = auth.uid());

-- NO write policy for the office. `is_office()` includes ESTIMATORS, who are
-- themselves signing contractors — a `for all` office-write policy would let one
-- contractor forge / alter / delete another's signed agreement, destroying the
-- IR35 evidence integrity this table exists to provide. The office only ever
-- READS the register (granted above). Append-only for everyone: the signer
-- inserts their own row and no one can update or delete it. If a genuine admin
-- correction is ever needed, add an is_admin()-only DELETE routed through an
-- audited server action (never estimator, never UPDATE of a signature).
