-- Staff & Fleet record writes → admin-only (2026-07-20 security review, MED-4).
--
-- Deferred finding from the 2026-07-20 hardening sweep: 0054 gated staff
-- INSERT/UPDATE on `is_office()`, but estimators ARE is_office() (is_admin OR
-- estimator). staff.profile_id is an AUTH KEY — the availability (0053),
-- staff_statements (0065) and staff_pay self-scopes all trust
-- `staff_id in (select id from staff where profile_id = auth.uid())`. So a
-- non-admin office user (an estimator) could PATCH any staff row's profile_id to
-- their own uid and hijack another person's availability, pay statements and
-- rate reads. Bounded after 0065 (not a self-payment vector) but a real
-- identity-hijack / rate-leak.
--
-- Decision (Peter, 2026-07-20): Staff & Fleet ROSTER management is an admin
-- function. Move staff + vehicle record writes to `is_admin()`, matching the
-- 0063 (crew rates) / 0065 (pay statements) precedent. Estimators keep every
-- other office capability — quotes, surveys, bookings, and crucially the
-- day-to-day SCHEDULING layer on top of these records: staff_availability
-- (0053) and vehicle_unavailability (off-road windows) both stay office and are
-- untouched here.
--
-- Crew/estimator self-link is preserved verbatim from 0054: a user may still
-- claim their OWN email-matched unlinked row on first login and update a row
-- already linked to them — they simply can never repoint profile_id at anyone
-- else, and non-admins can no longer create staff or edit foreign rows. Service
-- role (team-actions, seed scripts) bypasses RLS and is unaffected.

-- staff: create + general edit → admin; self-link branches unchanged.
drop policy if exists staff_insert on staff;
create policy staff_insert on staff for insert with check (is_admin());

drop policy if exists staff_update on staff;
create policy staff_update on staff for update
  using (
    is_admin()
    or profile_id = auth.uid()
    or (profile_id is null and email is not null and lower(email) = my_email())
  )
  with check (
    is_admin()
    or (profile_id = auth.uid() and email is not null and lower(email) = my_email())
  );

-- vehicles: the fleet record (compliance dates, cost, lease) → admin. Reads stay
-- is_staff() (the Job Board + reminders need them); off-road windows
-- (vehicle_unavailability) are a separate scheduling table, left office.
drop policy if exists vehicles_insert on vehicles;
create policy vehicles_insert on vehicles for insert with check (is_admin());

drop policy if exists vehicles_update on vehicles;
create policy vehicles_update on vehicles for update using (is_admin()) with check (is_admin());

notify pgrst, 'reload schema';
