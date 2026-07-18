-- Per-staff weekly working pattern (2026-07-18). Availability's default (0053)
-- was a hardcoded Mon–Fri for EVERY crew member. Real crew differ: some are
-- retained 5-day, some are casual (fewer days), some regularly work weekends.
-- working_days is the per-person baseline — the ISO weekday numbers
-- (1=Mon … 7=Sun) they're normally expected to be available. A staff_availability
-- row (0053) still overrides a SINGLE date on top of this baseline
-- ('unavailable' = a normal day booked off, 'available' = a non-pattern day
-- offered). Default '{1,2,3,4,5}' = Mon–Fri, so every existing crew member's
-- behaviour is unchanged; a casual who only does Mon/Tue is set to '{1,2}' and no
-- longer has to book Wed/Thu/Fri off every week forever. Empty '{}' is allowed —
-- a fully-casual worker with no fixed days who only offers specific dates.
alter table public.staff
  add column working_days int[] not null default '{1,2,3,4,5}';

-- Only weekday numbers 1..7, no nulls in the array. Empty array passes (casual).
alter table public.staff
  add constraint staff_working_days_valid check (
    working_days <@ '{1,2,3,4,5,6,7}'::int[]
    and array_position(working_days, null) is null
  );
