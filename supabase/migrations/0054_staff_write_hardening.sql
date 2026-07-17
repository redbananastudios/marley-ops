-- Harden staff writes (2026-07-18 security review). Migration 0020 set
-- `staff_update USING (is_staff())` with NO `with check`, so any crew login could
-- PATCH any staff row's profile_id to their own uid — hijacking the
-- staff_availability self-scope (0053), reassigning who they appear as on the Job
-- Board / job sheets, and reading every day_rate via the row. The 0053
-- availability RLS trusts staff.profile_id as an auth key, so that column MUST be
-- write-protected.
--
-- Fix: gate staff INSERT to office (crew never create staff records), and
-- constrain staff UPDATE so a crew user can only (a) update a row already linked
-- to them or (b) claim their OWN email-matched, still-unlinked row on first login
-- — and can NEVER repoint profile_id at anyone. Office keeps full control. The
-- only crew-context staff write in the app is the login self-link in
-- /my-jobs*/page.tsx (`update {profile_id} where email ilike <me> and null`),
-- which both branches below preserve. Service-role paths (team-actions, seed
-- scripts) bypass RLS and are unaffected. DELETE stays admin-only (0020).

-- Caller's own profile email. security definer so the policy doesn't depend on
-- profiles RLS; mirrors is_staff()/is_office().
create or replace function my_email() returns text
language sql security definer stable set search_path = public as $$
  select lower(email) from public.profiles where id = auth.uid();
$$;

drop policy if exists staff_insert on staff;
create policy staff_insert on staff for insert with check (is_office());

drop policy if exists staff_update on staff;
create policy staff_update on staff for update
  using (
    is_office()
    or profile_id = auth.uid()
    or (profile_id is null and email is not null and lower(email) = my_email())
  )
  with check (
    is_office()
    or (profile_id = auth.uid() and email is not null and lower(email) = my_email())
  );
