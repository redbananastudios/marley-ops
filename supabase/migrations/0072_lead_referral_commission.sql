-- 3rd-party commission owed for a lead (Peter, 2026-07-21): some manually-added
-- leads carry a referral fee to a third party. Recorded per lead and counted as
-- a cost of that lead's job in the profit/margin reports (dashboard KPI +
-- Performance "Jobs & margin"). Null/0 = no commission.

alter table public.leads
  add column if not exists referral_commission numeric(10,2);

comment on column public.leads.referral_commission is
  '3rd-party referral fee owed for this lead (GBP). Deducted from the job''s profit in margin reports.';
