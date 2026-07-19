-- 0066: relock communications + activities READ to is_office() (2026-07-20 hardening review).
--
-- 0001's operational-table loop created these read policies as `using(is_staff())`.
-- Migration 0024 relocked the money tables (quotes, business_settings,
-- estimator_payouts, storage_lets) with the explicit rationale "a crew login could
-- read pricing through the API even though the UI hides it" — but MISSED these two.
--   communications.body = the rendered quote/deposit/balance email (grand total,
--     £100 deposit, balance owed) + to_address
--   activities.meta      = agreed_price / amount_pence on won/paid events
-- So a crew JWT (is_staff() true, is_office() false) could `GET /rest/v1/communications
-- ?select=body,to_address` (or /activities) with the public anon key and read every
-- customer's pricing + contact data — the exact exposure 0024 exists to prevent.
--
-- READS ONLY. Verified no crew /my-jobs surface reads either table via the session
-- client. INSERTS stay is_staff() on purpose — crew notes write a lead-timeline
-- activity (job-notes), and crew surfaces write via the service role anyway.

drop policy if exists communications_read on public.communications;
create policy communications_read on public.communications for select using (is_office());

drop policy if exists activities_read on public.activities;
create policy activities_read on public.activities for select using (is_office());
