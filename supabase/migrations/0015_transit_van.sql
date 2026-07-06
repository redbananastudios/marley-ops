-- Transit van: internal day rate for the margin model (customer prices live in the
-- editable business_settings.pricing jsonb — transit tier + add-on price merge over
-- the code defaults, so no pricing column is needed).
alter table public.business_settings
  add column if not exists cost_transit_day numeric(10,2) not null default 0;
