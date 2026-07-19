-- 0063: crew pay rates are ADMIN-only (Peter, 2026-07-19).
--
-- Estimators manage crew AVAILABILITY but must not see crew pay rates (an
-- estimator is a contractor too). Tighten staff_pay from is_office() (= admin OR
-- estimator) down to admin — while KEEPING the crew self-read so a crew member
-- can still pre-fill their own invoice rate.
drop policy if exists staff_pay_read on public.staff_pay;
drop policy if exists staff_pay_write on public.staff_pay;

create policy staff_pay_read on public.staff_pay for select
  using (is_admin() or staff_id in (select id from public.staff where profile_id = auth.uid()));
create policy staff_pay_write on public.staff_pay for all
  using (is_admin())
  with check (is_admin());
