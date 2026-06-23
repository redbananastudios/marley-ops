-- Labour is a fixed day rate per man (full 8h day), not hourly.
-- Crew size is derived from the van config (1 Luton=2, 2=3, 3=4, +1 for 7.5t), so the
-- only labour lever is the day rate. Replaces the per-hour field (added 0005, never
-- populated — all zero in dev).
alter table business_settings add column if not exists cost_labour_per_day numeric(10,2) not null default 120;
alter table business_settings drop column if exists cost_labour_per_hour;
