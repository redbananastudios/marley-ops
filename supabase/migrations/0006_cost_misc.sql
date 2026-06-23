-- Misc / consumables cost (tape, wrap, sundries) for the rate card + margin calc.
alter table business_settings add column if not exists cost_misc numeric(10,2) not null default 0;
