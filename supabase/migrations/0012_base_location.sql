-- Base / yard location (single source of truth for mileage origin + the clients
-- map "route from base"). Defaults to the Marley yard the live quote tool hardcoded.
alter table public.business_settings
  add column if not exists base_location text not null
  default 'Ash Cottage, Sherborne Causeway, Shaftesbury, SP7 9PX';
