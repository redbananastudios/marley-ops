-- 0044: office read policy for card_payments (fix, 2026-07-15).
--
-- 0043 shipped the table RLS-enabled with NO policies on the theory that all
-- reads go through service-role server actions — but the Bookings page (card
-- attempt chip) and the new Payments page read it through the USER server
-- client, which silently returned zero rows. Money tables follow the 0024
-- lockdown pattern: is_office() (admin | estimator) may read, crew may not.
-- Writes stay service-role only (no insert/update/delete policies).

create policy card_payments_read on card_payments for select using (is_office());
