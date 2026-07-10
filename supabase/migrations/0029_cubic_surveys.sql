-- 0029: cubic survey (Peter, 2026-07-10 — clone-and-improve of iMVE's cubic
-- sheet; full audit in docs/cubic-survey-audit.md).
--
--  cubic_surveys  one volume survey per lead: the itemised inventory with
--                 cubic-feet values, captured by the estimator on a tablet
--                 (primary) or by the customer via the tokenised /cv/<token>
--                 page (secondary). items jsonb carries catalogue lines AND
--                 custom one-offs in one shape; total_ft3 is denormalised so
--                 lists and the quote wizard never re-sum. Triple-anchored
--                 (lead/client/appointment, all SET NULL) like job_notes so
--                 the record survives diary changes.
--
-- Van maths lives in code (lib/cubic-survey.ts) off the capacity settings
-- added to business_settings below — editable without a deploy.

create table cubic_surveys (
  id             uuid primary key default gen_random_uuid(),
  lead_id        uuid references leads(id) on delete set null,
  client_id      uuid references clients(id) on delete set null,
  appointment_id uuid references appointments(id) on delete set null,
  items          jsonb not null default '[]'::jsonb,
  total_ft3      numeric(10,1) not null default 0,
  notes          text not null default '',
  status         text not null default 'draft' check (status in ('draft','complete','customer_submitted')),
  -- Customer self-fill link (minted lazily, /q + /s pattern).
  share_token    text unique,
  created_by     uuid references profiles(id) on delete set null,
  updated_by     uuid references profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- One live survey per lead — the second creator gets a clean conflict.
create unique index cubic_surveys_lead_uq on cubic_surveys(lead_id) where lead_id is not null;
create index cubic_surveys_client_idx on cubic_surveys(client_id);

create trigger trg_cubic_surveys_updated before update on cubic_surveys
  for each row execute function set_updated_at();

alter table cubic_surveys enable row level security;

-- Crew/estimators can survey (no money here); delete stays admin.
create policy cubic_surveys_read   on cubic_surveys for select using (is_staff());
create policy cubic_surveys_insert on cubic_surveys for insert with check (is_staff());
create policy cubic_surveys_update on cubic_surveys for update using (is_staff());
create policy cubic_surveys_delete on cubic_surveys for delete using (is_admin());

-- Cubic survey photos ride the existing survey-photos pipeline.
alter type photo_category add value if not exists 'cubic';

-- Van-load planning inputs (usable ft3 per vehicle class + the fill factor
-- crews actually pack to). Defaults per docs/cubic-survey-audit.md.
alter table business_settings add column if not exists cubic_fill_pct    numeric(5,2) not null default 90;
alter table business_settings add column if not exists cubic_transit_ft3 numeric(10,1) not null default 280;
alter table business_settings add column if not exists cubic_luton_ft3   numeric(10,1) not null default 550;
alter table business_settings add column if not exists cubic_75t_ft3     numeric(10,1) not null default 1400;
