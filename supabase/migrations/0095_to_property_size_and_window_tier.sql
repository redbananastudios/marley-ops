-- 0095: destination property size + structured move-window tier (Peter, 2026-08-14).
--
-- 1. leads.to_property_size — the panel now records the property size at BOTH
--    ends of the move (the website form still sends only the "from" size).
--
-- 2. booking_details.approx_window becomes the structured 3-tier window
--    ("Beginning / Middle / End of <approx_month>"): 'early' | 'mid' | 'late'.
--    It was free text ("mid-August"); the table held ZERO rows on prod and
--    staging when this shipped (verified 2026-08-14), so no data rewrite is
--    needed — the check constraint simply pins the new vocabulary.

alter table public.leads
  add column if not exists to_property_size text;

alter table public.booking_details
  add constraint booking_details_approx_window_check
  check (approx_window is null or approx_window in ('early', 'mid', 'late'));
