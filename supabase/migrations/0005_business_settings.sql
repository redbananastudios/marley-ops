-- Business settings — a single-row config for editable rates + costs.
-- v1: the estimator fee per attended visit (moves off the hardcoded constant and
-- feeds Performance + the dashboard panel) plus the internal cost rates Connor will
-- populate, ready to drive margin-per-job once the cost formula is agreed.
-- Singleton: id is a boolean fixed to true, so there's only ever one row.

create table business_settings (
  id                   boolean primary key default true check (id),
  estimator_fee        numeric(10,2) not null default 50,
  cost_fuel_per_mile   numeric(10,2) not null default 0,
  cost_labour_per_hour numeric(10,2) not null default 0,
  cost_box             numeric(10,2) not null default 0,
  cost_van_day         numeric(10,2) not null default 0,
  updated_at           timestamptz not null default now()
);

create trigger trg_business_settings_updated
  before update on business_settings for each row execute function set_updated_at();

-- seed the single row
insert into business_settings (id) values (true) on conflict (id) do nothing;

-- RLS: any active staff can read; only admins can change.
alter table business_settings enable row level security;
create policy business_settings_read   on business_settings for select using (is_staff());
create policy business_settings_update on business_settings for update using (is_admin());
create policy business_settings_insert on business_settings for insert with check (is_admin());
