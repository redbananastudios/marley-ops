-- Job Board v2 — per-appointment resource assignment (iMVE clone-and-improve,
-- docs/imve-discovery.md §1). One row = one staff member OR one vehicle on one
-- appointment; a multi-day move is one appointment, so its crew rides the whole
-- span (iMVE's per-day split arrives if Connor ever needs it). Double-booking is
-- allowed deliberately (a van can do two half-day jobs) — the UI warns on clash
-- instead of the DB blocking it.

create table appointment_assignments (
  id              uuid primary key default gen_random_uuid(),
  appointment_id  uuid not null references appointments(id) on delete cascade,
  staff_id        uuid references staff(id),
  vehicle_id      uuid references vehicles(id),
  created_at      timestamptz not null default now(),
  -- exactly one resource per row
  check ((staff_id is null) <> (vehicle_id is null)),
  unique (appointment_id, staff_id),
  unique (appointment_id, vehicle_id)
);
create index appt_assign_appt_idx on appointment_assignments(appointment_id);
create index appt_assign_staff_idx on appointment_assignments(staff_id);
create index appt_assign_vehicle_idx on appointment_assignments(vehicle_id);

alter table appointment_assignments enable row level security;
create policy appointment_assignments_read   on appointment_assignments for select using (is_staff());
create policy appointment_assignments_insert on appointment_assignments for insert with check (is_staff());
create policy appointment_assignments_update on appointment_assignments for update using (is_staff());
create policy appointment_assignments_delete on appointment_assignments for delete using (is_staff());
