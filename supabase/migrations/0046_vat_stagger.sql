-- VAT quarter cycle (HMRC stagger group) — drives the Finance page's
-- "VAT quarter to date" rollup. 1 = quarters ending Mar/Jun/Sep/Dec,
-- 2 = Apr/Jul/Oct/Jan, 3 = May/Aug/Nov/Feb. Editable in Settings.
alter table business_settings
  add column if not exists vat_stagger_group smallint not null default 1;
