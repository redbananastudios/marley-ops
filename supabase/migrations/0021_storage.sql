-- Storage phase 1 — sites, units and lets, cloned-and-improved from iMVE
-- (see docs/imve-discovery.md §3). Occupancy is DERIVED: a unit is occupied
-- while it has a let with end_date null. Billing stays manual in Zoho for now
-- (phase 2 wires the recurring-invoice cron), so lets just record the agreed
-- rate. Sites/units archive rather than delete once lets reference them.

create table storage_sites (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  address     text not null default '',
  notes       text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger trg_storage_sites_updated before update on storage_sites
  for each row execute function set_updated_at();

create table storage_units (
  id          uuid primary key default gen_random_uuid(),
  site_id     uuid not null references storage_sites(id),
  code        text not null default '',                    -- e.g. 40FT-SC-650441
  name        text not null default '',
  unit_type   text not null default 'crate_250'
                check (unit_type in ('crate_250', 'container_20ft', 'container_40ft', 'room', 'other')),
  size_cuft   numeric(10,1),
  notes       text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index storage_units_site_idx on storage_units(site_id);
create trigger trg_storage_units_updated before update on storage_units
  for each row execute function set_updated_at();

create table storage_lets (
  id          uuid primary key default gen_random_uuid(),
  unit_id     uuid not null references storage_units(id),
  client_id   uuid not null references clients(id),
  lead_id     uuid references leads(id),
  start_date  date not null,
  end_date    date,                                        -- null = the let is open
  rate        numeric(10,2),
  rate_period text not null default 'week' check (rate_period in ('week', 'month')),
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index storage_lets_unit_idx on storage_lets(unit_id);
create index storage_lets_client_idx on storage_lets(client_id);
-- One open let per unit — the DB backstop for the occupancy model.
create unique index storage_lets_open_uq on storage_lets(unit_id) where end_date is null;
create trigger trg_storage_lets_updated before update on storage_lets
  for each row execute function set_updated_at();

alter table storage_sites enable row level security;
alter table storage_units enable row level security;
alter table storage_lets enable row level security;

do $$
declare t text;
begin
  foreach t in array array['storage_sites', 'storage_units', 'storage_lets'] loop
    execute format('create policy %1$s_read   on %1$s for select using (is_staff());', t);
    execute format('create policy %1$s_insert on %1$s for insert with check (is_staff());', t);
    execute format('create policy %1$s_update on %1$s for update using (is_staff());', t);
    execute format('create policy %1$s_delete on %1$s for delete using (is_admin());', t);
  end loop;
end $$;
