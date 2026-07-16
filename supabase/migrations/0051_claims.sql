-- Claims & exceptions — stage 2 (Peter, 2026-07-16). Stage 1 (ef3a637) raises a
-- next-morning call task when a sign-off records exceptions; this gives the
-- claim itself a record: status trail open → assessing → offer_made →
-- settled/rejected/closed, resolution + amount (goodwill spend visibility),
-- insurer reference, and the evidence links an insurer asks for. Office-only —
-- liability + money posture, same as invoices. Deadline note: the generic T&Cs
-- give customers 7 days from completion to report damage (legal review pending,
-- ClickUp 869e35z42) — the UI computes that window from the linked completion.

create table public.claims (
  id uuid primary key default gen_random_uuid(),
  -- human ref for insurer correspondence: CLM-001, CLM-002, …
  claim_no int generated always as identity unique,
  lead_id uuid not null references public.leads(id) on delete restrict,
  client_id uuid references public.clients(id) on delete set null,
  completion_id uuid references public.job_completions(id) on delete set null,
  status text not null default 'open'
    check (status in ('open','assessing','offer_made','settled','rejected','closed')),
  reported_at timestamptz not null default now(),
  reported_channel text not null default 'other'
    check (reported_channel in ('sign_off','phone','email','in_person','other')),
  description text not null,
  resolution text
    check (resolution in ('goodwill_payment','insurer_claim','repair','no_claim','rejected')),
  resolution_amount numeric(10,2),
  insurer_ref text not null default '',
  insurer_notified_at timestamptz,
  notes text not null default '',
  opened_by uuid references public.profiles(id) on delete set null,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- a finished claim must say how it finished
  check (status not in ('settled','rejected','closed') or resolution is not null)
);

create index claims_lead_idx on public.claims (lead_id);
create index claims_open_idx on public.claims (status)
  where status in ('open','assessing','offer_made');
-- never-create-twice backstop for the sign-off auto-open (the action also checks)
create unique index claims_signoff_once on public.claims (completion_id)
  where reported_channel = 'sign_off';

create trigger trg_claims_updated
  before update on public.claims
  for each row execute function public.set_updated_at();

alter table public.claims enable row level security;
create policy claims_read   on public.claims for select using (is_office());
create policy claims_insert on public.claims for insert with check (is_office());
create policy claims_update on public.claims for update using (is_office());
create policy claims_delete on public.claims for delete using (is_admin());
