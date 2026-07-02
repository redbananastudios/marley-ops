-- Follow-ups: the explicit work queue (no-answer retries, quote chases, deposit /
-- balance chases). Manual-first; `source` + `metadata` leave room for Phase-2
-- auto-creation without schema churn. Plus Phase-1 manual payment fields on leads
-- and a default deposit figure in settings.

create type follow_up_reason as enum ('no_answer', 'quote_followup', 'deposit', 'balance', 'custom');
create type follow_up_status as enum ('open', 'done', 'cancelled');
create type follow_up_outcome as enum ('reached', 'no_answer', 'no_answer_exhausted', 'paid', 'declined', 'cancelled');

create table follow_ups (
  id              uuid primary key default gen_random_uuid(),
  lead_id         uuid not null references leads(id) on delete cascade,
  client_id       uuid references clients(id) on delete set null,
  quote_id        uuid references quotes(id) on delete set null,
  reason          follow_up_reason not null,
  status          follow_up_status not null default 'open',
  due_at          timestamptz not null,
  assigned_to     uuid references profiles(id) on delete set null,
  source          text not null default 'manual',
  created_by      uuid references profiles(id) on delete set null,
  attempt_count   int not null default 0,
  last_attempt_at timestamptz,
  outcome         follow_up_outcome,
  notes           text,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index follow_ups_queue_idx on follow_ups(status, due_at);
create index follow_ups_lead_idx on follow_ups(lead_id);
create trigger trg_follow_ups_updated before update on follow_ups for each row execute function set_updated_at();

alter table follow_ups enable row level security;
create policy follow_ups_read   on follow_ups for select using (is_staff());
create policy follow_ups_insert on follow_ups for insert with check (is_staff());
create policy follow_ups_update on follow_ups for update using (is_staff());
create policy follow_ups_delete on follow_ups for delete using (is_admin());

-- Phase-1 payments: manual state on the lead (job = confirmed lead + accepted quote).
alter table leads
  add column if not exists deposit_amount       numeric(10,2),
  add column if not exists deposit_requested_at timestamptz,
  add column if not exists deposit_paid_at      timestamptz,
  add column if not exists balance_amount       numeric(10,2),
  add column if not exists balance_due_date     date,
  add column if not exists balance_paid_at      timestamptz;

-- Standard deposit figure (editable per job when requesting).
alter table business_settings
  add column if not exists default_deposit numeric(10,2) not null default 0;
