-- Staff availability (Peter, 2026-07-17) — crew are self-employed and "usually
-- Mon–Fri", so the business needs to know (a) who can work a given WEEKEND and
-- (b) who is OFF on a normally-working day (holiday / other commitment). Reuses
-- the vehicle_unavailability shape (0052): one row per staff per date, an
-- explicit override of the default. The Job Board reads it to drop an
-- unavailable crew member from that day's "N/N crew free" strip, exactly like an
-- off-road van. Weekends per-date was Peter's call (not a recurring pattern).
--
-- Default (NO row): weekday = available, weekend = off. So a login-less crew
-- member behaves sensibly on the board without any data. A row overrides the
-- default for that one date: 'available' offers a weekend, 'unavailable' books a
-- weekday off.

create table public.staff_availability (
  id          uuid primary key default gen_random_uuid(),
  staff_id    uuid not null references public.staff(id) on delete cascade,
  date        date not null,
  status      text not null check (status in ('available', 'unavailable')),
  note        text,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (staff_id, date)
);
create index staff_availability_staff_idx on public.staff_availability (staff_id, date);
create trigger trg_staff_availability_updated
  before update on public.staff_availability
  for each row execute function public.set_updated_at();

alter table public.staff_availability enable row level security;

-- Office manages anyone's; a crew member manages ONLY their own (the staff row
-- linked to their login). The subquery reads `staff`, whose own read policy is
-- is_staff() — a crew login can see staff rows, so the self-check resolves.
create policy staff_availability_read on public.staff_availability for select
  using (
    is_office()
    or staff_id in (select id from public.staff where profile_id = auth.uid())
  );
create policy staff_availability_insert on public.staff_availability for insert
  with check (
    is_office()
    or staff_id in (select id from public.staff where profile_id = auth.uid())
  );
create policy staff_availability_update on public.staff_availability for update
  using (
    is_office()
    or staff_id in (select id from public.staff where profile_id = auth.uid())
  )
  with check (
    is_office()
    or staff_id in (select id from public.staff where profile_id = auth.uid())
  );
create policy staff_availability_delete on public.staff_availability for delete
  using (
    is_office()
    or staff_id in (select id from public.staff where profile_id = auth.uid())
  );
