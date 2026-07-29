-- 0081: public staff onboarding.
-- One shared tokenised link (/join/<token>) goes to the crew WhatsApp group;
-- each person submits their own details into staff_submissions. Office reviews
-- and approves into staff (update a matching active row, else insert a new crew
-- record). The token + kill switch live on business_settings.

-- Submissions land via the SERVICE-ROLE client only — there is deliberately NO
-- insert policy, so anon/authenticated roles cannot write directly even though
-- the page itself is public.
create table if not exists staff_submissions (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  date_of_birth date,
  address text,
  email text,
  phone text,
  is_driver boolean not null default false,
  emergency_contact_name text,
  emergency_contact_phone text,
  notes text,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  reviewed_by uuid references profiles(id) on delete set null,
  reviewed_at timestamptz,
  staff_id uuid references staff(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger trg_staff_submissions_updated
  before update on staff_submissions
  for each row execute function set_updated_at();

alter table staff_submissions enable row level security;

create policy staff_submissions_read   on staff_submissions for select using (is_office());
create policy staff_submissions_update on staff_submissions for update using (is_admin());
create policy staff_submissions_delete on staff_submissions for delete using (is_admin());

-- The approved details need somewhere to live on the staff record itself.
alter table staff add column if not exists address text;
alter table staff add column if not exists date_of_birth date;
alter table staff add column if not exists emergency_contact_name text;
alter table staff add column if not exists emergency_contact_phone text;

-- Shared join-link credential + kill switch (regenerating the token kills the
-- old link; disabling kills them all).
alter table business_settings add column if not exists staff_onboard_token text;
alter table business_settings add column if not exists staff_onboard_enabled boolean not null default false;
