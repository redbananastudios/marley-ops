-- Milestone A: speed-to-lead + quote acceptance with an agreed price.
-- Additive only — safe to apply over live data.

-- First time a lead is engaged (first status move / explicit contact).
-- Powers the dashboard "median response time" metric.
alter table leads add column if not exists first_contacted_at timestamptz;

-- Quote acceptance: the agreed price (may differ from the quoted grand_total)
-- is the booked revenue; accepted_at stamps when it was won.
alter table quotes add column if not exists agreed_price numeric(10,2);
alter table quotes add column if not exists accepted_at timestamptz;
