-- Vehicles + Staff (crew) — the assignable resources for the coming Job Board v2,
-- cloned-and-improved from iMVE (see docs/imve-discovery.md). Vehicles carry the
-- compliance dates iMVE stores but never surfaces; staff covers crew who are NOT
-- login users (profiles stay the login layer; staff.profile_id links the two).

create table vehicles (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,                       -- callsign, e.g. "Luton 1"
  vehicle_type       text not null default 'luton'
                       check (vehicle_type in ('luton', 'transit', '7.5t', 'other')),
  registration       text not null default '',
  tax_due            date,
  mot_due            date,
  insurance_renewal  date,
  last_service       date,
  cost_per_month     numeric(10,2),
  payment_day        int check (payment_day between 1 and 31),
  end_of_term        date,
  notes              text,
  is_active          boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create trigger trg_vehicles_updated before update on vehicles
  for each row execute function set_updated_at();

create table staff (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid references profiles(id),               -- set when they also have a login
  full_name   text not null,
  staff_role  text not null default 'crew'
                check (staff_role in ('crew', 'driver', 'estimator', 'admin')),
  phone       text,
  email       text,
  day_rate    numeric(10,2),
  notes       text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger trg_staff_updated before update on staff
  for each row execute function set_updated_at();

alter table vehicles enable row level security;
alter table staff enable row level security;

do $$
declare t text;
begin
  foreach t in array array['vehicles', 'staff'] loop
    execute format('create policy %1$s_read   on %1$s for select using (is_staff());', t);
    execute format('create policy %1$s_insert on %1$s for insert with check (is_staff());', t);
    execute format('create policy %1$s_update on %1$s for update using (is_staff());', t);
    execute format('create policy %1$s_delete on %1$s for delete using (is_admin());', t);
  end loop;
end $$;
