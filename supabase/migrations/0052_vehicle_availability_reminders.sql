-- Vehicle availability + fleet-expiry reminders (docs/vehicle-availability-reminders-prd.md,
-- Peter 2026-07-17). Off-road windows drop a van from Job Board capacity; a daily cron
-- reminds admin as MOT / Tax / Insurance / Lease / Service approach, from 4 weeks out.
-- Vehicles first; staff availability is a later build that reuses this shape.

-- Next-service-due date. last_service already records the last one; this is the
-- forward-looking date that drives the "book it into the garage" reminder.
alter table public.vehicles add column service_due date;

-- Off-road windows — the van is unavailable (garage / repair) across the inclusive range.
create table public.vehicle_unavailability (
  id          uuid primary key default gen_random_uuid(),
  vehicle_id  uuid not null references public.vehicles(id) on delete cascade,
  start_date  date not null,
  end_date    date not null,
  reason      text not null default 'other'
                check (reason in ('service','mot','repair','other')),
  note        text,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (end_date >= start_date)
);
create index vehicle_unavailability_vehicle_idx
  on public.vehicle_unavailability (vehicle_id, start_date);
create trigger trg_vehicle_unavailability_updated
  before update on public.vehicle_unavailability
  for each row execute function public.set_updated_at();

alter table public.vehicle_unavailability enable row level security;
create policy vehicle_unavailability_read   on public.vehicle_unavailability for select using (is_staff());
create policy vehicle_unavailability_insert on public.vehicle_unavailability for insert with check (is_office());
create policy vehicle_unavailability_update on public.vehicle_unavailability for update using (is_office());
create policy vehicle_unavailability_delete on public.vehicle_unavailability for delete using (is_office());

-- Never-send-twice ledger for the reminder cron. Keyed on due_date so RENEWING a
-- date (pushing it out) starts a fresh reminder cycle automatically. Overdue alerts
-- re-fire weekly by using a week-stamped threshold ('overdue-YYYY-Www'), which stays
-- unique per week under the constraint below.
create table public.vehicle_reminder_log (
  id           uuid primary key default gen_random_uuid(),
  vehicle_id   uuid not null references public.vehicles(id) on delete cascade,
  expiry_type  text not null,            -- tax_due | mot_due | insurance_renewal | service_due | end_of_term
  due_date     date not null,
  threshold    text not null,            -- '28' | '14' | '7' | '3' | '0' | 'overdue-YYYY-Www'
  sent_at      timestamptz not null default now(),
  unique (vehicle_id, expiry_type, due_date, threshold)
);
create index vehicle_reminder_log_vehicle_idx
  on public.vehicle_reminder_log (vehicle_id, expiry_type, due_date);

alter table public.vehicle_reminder_log enable row level security;
-- Office reads it (dashboard needs-action); the cron writes via the service role (bypasses RLS).
create policy vehicle_reminder_log_read on public.vehicle_reminder_log for select using (is_staff());

-- Reminder settings on the single-row business_settings.
-- Recipients seeded later (Settings UI / M3) — kept empty here so no email ships from a migration.
alter table public.business_settings
  add column fleet_reminders_enabled boolean not null default true,
  add column fleet_alert_recipients  text[]  not null default '{}';
