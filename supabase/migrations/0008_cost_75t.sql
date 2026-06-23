-- 7.5-tonne lorry cost per job (includes its 1 man). Used when a job has the 7.5t.
-- Labour bills only the extra crew (each vehicle's driver is covered by the vehicle cost),
-- so the 7.5t's man is already inside this figure.
alter table business_settings add column if not exists cost_75t numeric(10,2) not null default 1800;
