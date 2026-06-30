-- Separate fuel cost-per-mile for the 7.5t lorry (Luton fuel uses cost_fuel_per_mile).
alter table public.business_settings
  add column if not exists cost_fuel_75_per_mile numeric(10,2) not null default 0.50;
