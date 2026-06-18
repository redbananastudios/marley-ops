-- Marley Ops — v1 schema (M1a foundation).
-- 10 lean tables. No separate `jobs` table in v1: a "booking" = a lead in
-- `confirmed` status with an accepted quote + a removal appointment.
-- Conventions: uuid PKs, timestamptz created/updated (+ trigger), numeric(10,2)
-- money, Postgres enums for statuses, RLS on every table.

create extension if not exists "pgcrypto";   -- gen_random_uuid()
create extension if not exists "citext";      -- case-insensitive email

-- ============================================================ enums
create type user_role          as enum ('admin', 'estimator');
create type lead_status         as enum ('website_enquiry','survey_booked','quoted','provisional','confirmed','completed','declined');
create type lead_entry_channel  as enum ('web','phone_google','phone_facebook','phone_referral','manual','referral');
create type quote_status        as enum ('draft','sent','accepted','rejected','superseded');
create type appt_type           as enum ('survey','removal');
create type appt_status         as enum ('scheduled','completed','cancelled');
create type survey_status       as enum ('scheduled','completed','cancelled');
create type photo_category      as enum ('access','large_items');
create type comm_channel        as enum ('email','sms');
create type comm_status         as enum ('queued','sent','failed','blocked_duplicate');
create type activity_type       as enum ('note','status_change','call','email_sent','sms_sent','quote_sent','survey_booked','merge','lead_created');

-- ============================================================ shared helpers
create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

-- ============================================================ profiles
create table profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text not null default '',
  email       citext,
  role        user_role not null default 'estimator',
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index profiles_role_idx on profiles(role);
create trigger trg_profiles_updated before update on profiles for each row execute function set_updated_at();

-- role helpers (security definer so RLS policies can call them)
create or replace function is_staff() returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and active);
$$;
create or replace function is_admin() returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and active and role = 'admin');
$$;

-- auto-create a profile row when an auth user is created (default estimator)
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', ''))
  on conflict (id) do nothing;
  return new;
end; $$;
create trigger trg_auth_user_created after insert on auth.users
  for each row execute function handle_new_user();

-- ============================================================ clients (dedupe target)
create table clients (
  id              uuid primary key default gen_random_uuid(),
  display_name    text,
  email           citext,
  email_norm      text generated always as (nullif(lower(trim(email::text)), '')) stored,
  phone_raw       text,
  phone_e164      text,
  postcode_home   text,
  notes           text,
  merged_into_id  uuid references clients(id),
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
-- dedupe spine: one live client per phone, one per email (tombstones excluded)
create unique index clients_phone_uq on clients(phone_e164) where phone_e164 is not null and merged_into_id is null;
create unique index clients_email_uq on clients(email_norm) where email_norm is not null and merged_into_id is null;
create index clients_merged_idx on clients(merged_into_id);
create trigger trg_clients_updated before update on clients for each row execute function set_updated_at();

-- ============================================================ leads (the funnel object)
create table leads (
  id                  uuid primary key default gen_random_uuid(),
  client_id           uuid not null references clients(id),
  estimator_id        uuid references profiles(id),
  status              lead_status not null default 'website_enquiry',
  entry_channel       lead_entry_channel not null default 'manual',
  referrer_answer     text,
  source_system       text not null default 'marley_ops',   -- 'website' | 'marley_ops' | 'import'
  source_form         text,
  -- mirror of quoteSubmission lead fields
  name                text,
  phone               text,
  email               citext,
  from_postcode       text,
  to_postcode         text,
  property_size       text,
  preferred_date      date,
  services            text[] not null default '{}',
  notes               text,
  submitted_at        timestamptz not null default now(),
  -- full flat attribution (one column each)
  gclid               text,
  gbraid              text,
  wbraid              text,
  fbclid              text,
  msclkid             text,
  ttclid              text,
  li_fat_id           text,
  utm_source          text,
  utm_medium          text,
  utm_campaign        text,
  utm_content         text,
  utm_term            text,
  utm_id              text,
  landing_url         text,
  landing_referrer    text,
  campaign            text,
  variant_key         text,
  posthog_distinct_id text,                                  -- stored, unused in v1
  -- sync idempotency
  sanity_id           text,
  external_lead_id    text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create unique index leads_sanity_uq on leads(sanity_id) where sanity_id is not null;
create index leads_client_idx on leads(client_id);
create index leads_status_idx on leads(status);
create index leads_estimator_idx on leads(estimator_id);
create index leads_channel_idx on leads(entry_channel);
create index leads_submitted_idx on leads(submitted_at desc);
create index leads_campaign_idx on leads(campaign);
create index leads_gclid_idx on leads(gclid) where gclid is not null;
create trigger trg_leads_updated before update on leads for each row execute function set_updated_at();

-- ============================================================ quotes (cloned engine writes here)
create table quotes (
  id                     uuid primary key default gen_random_uuid(),
  quote_ref              text not null unique,               -- MM-YYMMDD-NNN
  client_id              uuid references clients(id),
  lead_id                uuid references leads(id),
  estimator_id           uuid references profiles(id),
  -- denormalised header (mirrors the live Neon columns)
  customer_name          text,
  customer_email         citext,
  customer_phone         text,
  collect_addr           text,
  dest_addr              text,
  moving_date            text,
  moving_date_estimated  boolean not null default false,
  vehicle                text,
  packing                text,
  -- money, numeric(10,2), preserved verbatim (subtotal incl. £150 admin fee)
  subtotal               numeric(10,2) not null default 0,
  discount               numeric(10,2) not null default 0,
  vat_enabled            boolean not null default false,
  vat_amount             numeric(10,2) not null default 0,
  grand_total            numeric(10,2) not null default 0,
  total_miles            numeric(10,2),
  breakdown              jsonb not null default '{}',         -- full computeQuote() output
  state_blob             jsonb not null default '{}',         -- full wizard state incl. new items
  status                 quote_status not null default 'draft',
  pdf_path               text,
  email_sent             boolean not null default false,
  email_sent_at          timestamptz,
  email_message_id       text,
  email_error            text,
  email_send_count       integer not null default 0,
  sms_send_count         integer not null default 0,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create index quotes_client_idx on quotes(client_id);
create index quotes_lead_idx on quotes(lead_id);
create index quotes_status_idx on quotes(status);
create index quotes_created_idx on quotes(created_at desc);
create trigger trg_quotes_updated before update on quotes for each row execute function set_updated_at();

-- ============================================================ surveys
create table surveys (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid references clients(id),
  lead_id         uuid references leads(id),
  estimator_id    uuid references profiles(id),
  status          survey_status not null default 'scheduled',
  survey_data     jsonb not null default '{}',               -- new items + access/large-item notes
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index surveys_lead_idx on surveys(lead_id);
create trigger trg_surveys_updated before update on surveys for each row execute function set_updated_at();

-- ============================================================ survey_photos (Storage linkage)
create table survey_photos (
  id            uuid primary key default gen_random_uuid(),
  survey_id     uuid not null references surveys(id) on delete cascade,
  category      photo_category not null,
  storage_path  text not null,
  caption       text,
  uploaded_by   uuid references profiles(id),
  created_at    timestamptz not null default now()
);
create index survey_photos_survey_idx on survey_photos(survey_id, category);

-- ============================================================ appointments (one source, both calendars)
create table appointments (
  id              uuid primary key default gen_random_uuid(),
  appt_type       appt_type not null,
  client_id       uuid references clients(id),
  lead_id         uuid references leads(id),
  survey_id       uuid references surveys(id),
  estimator_id    uuid references profiles(id),
  title           text,
  starts_at       timestamptz not null,
  ends_at         timestamptz not null,
  all_day         boolean not null default false,
  location        text,
  status          appt_status not null default 'scheduled',
  notes           text,
  gcal_event_id   text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index appointments_type_starts_idx on appointments(appt_type, starts_at);
create index appointments_estimator_idx on appointments(estimator_id, starts_at);
create index appointments_lead_idx on appointments(lead_id);
create trigger trg_appointments_updated before update on appointments for each row execute function set_updated_at();

-- ============================================================ communications (log + duplicate-guard)
create table communications (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid references clients(id),
  lead_id         uuid references leads(id),
  quote_id        uuid references quotes(id),
  channel         comm_channel not null,
  direction       text not null default 'outbound',
  to_address      text not null,
  to_norm         text not null,
  subject         text,
  body            text not null,
  attachment_ref  text,
  content_hash    text not null,
  send_count      integer not null default 0,
  first_sent_at   timestamptz,
  last_sent_at    timestamptz,
  status          comm_status not null default 'queued',
  provider        text,
  provider_id     text,
  provider_error  text,
  is_override     boolean not null default false,
  override_reason text,
  sent_by         uuid references profiles(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index communications_hash_idx on communications(content_hash);
-- DB backstop: an identical non-override content can be 'sent' only once
create unique index communications_sent_uq on communications(content_hash) where status = 'sent' and is_override = false;
create index communications_lead_idx on communications(lead_id, created_at desc);
create index communications_quote_idx on communications(quote_id);
create trigger trg_communications_updated before update on communications for each row execute function set_updated_at();

-- ============================================================ activities (timeline)
create table activities (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid references clients(id),
  lead_id     uuid references leads(id),
  actor_id    uuid references profiles(id),
  type        activity_type not null,
  summary     text not null,
  meta        jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
create index activities_lead_idx on activities(lead_id, created_at desc);
create index activities_client_idx on activities(client_id, created_at desc);

-- ============================================================ events_log (append-only audit)
create table events_log (
  id            bigint generated always as identity primary key,
  actor_id      uuid references profiles(id),
  entity_type   text not null,
  entity_id     uuid,
  action        text not null,
  diff          jsonb,
  created_at    timestamptz not null default now()
);
create index events_log_entity_idx on events_log(entity_type, entity_id, created_at desc);
create index events_log_action_idx on events_log(action);

-- ============================================================ RLS
alter table profiles       enable row level security;
alter table clients        enable row level security;
alter table leads          enable row level security;
alter table quotes         enable row level security;
alter table surveys        enable row level security;
alter table survey_photos  enable row level security;
alter table appointments   enable row level security;
alter table communications enable row level security;
alter table activities     enable row level security;
alter table events_log     enable row level security;

-- profiles: staff read all; a user updates self; admin updates anyone
create policy profiles_read   on profiles for select using (is_staff());
create policy profiles_self   on profiles for update using (id = auth.uid() or is_admin());

-- operational tables: any active staff read/insert/update; admin-only delete
do $$
declare t text;
begin
  foreach t in array array['clients','leads','quotes','surveys','survey_photos','appointments','communications','activities']
  loop
    execute format('create policy %1$s_read   on %1$s for select using (is_staff());', t);
    execute format('create policy %1$s_insert on %1$s for insert with check (is_staff());', t);
    execute format('create policy %1$s_update on %1$s for update using (is_staff());', t);
    execute format('create policy %1$s_delete on %1$s for delete using (is_admin());', t);
  end loop;
end $$;

-- events_log: any staff insert; admin-only read; no update/delete
create policy events_insert on events_log for insert with check (is_staff());
create policy events_read   on events_log for select using (is_admin());

-- ============================================================ Storage (private survey photos)
insert into storage.buckets (id, name, public) values ('survey-photos','survey-photos', false)
  on conflict (id) do nothing;
create policy survey_photos_read   on storage.objects for select using (bucket_id = 'survey-photos' and is_staff());
create policy survey_photos_write  on storage.objects for insert with check (bucket_id = 'survey-photos' and is_staff());
create policy survey_photos_delete on storage.objects for delete using (bucket_id = 'survey-photos' and is_admin());

-- ============================================================ grants
-- Base privileges for the Supabase roles. RLS still governs anon/authenticated;
-- service_role bypasses RLS but still needs the table GRANT.
grant usage on schema public to anon, authenticated, service_role;
grant all on all tables in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
grant all on all routines in schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
