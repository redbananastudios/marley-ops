-- Crew RLS lockdown (2026-07-20 final release review).
--
-- The crew product is deliberately assignment-scoped, but the original v1
-- policies treated every active login as trusted office staff.  That allowed a
-- crew JWT to enumerate/mutate the CRM directly through PostgREST, rewrite its
-- own profile role/active flag, and read/write every object in the three legacy
-- job-photo buckets.  UI redirects are not an authorization boundary.
--
-- Keep office behaviour intact, preserve the signed-in user's ability to read
-- their own profile, and make the only direct crew storage exception an object
-- whose first path segment belongs to one of their assigned jobs.  The helpers
-- compare trusted UUID columns AS text; untrusted object names are never cast to
-- uuid, so malformed paths fail closed instead of raising inside an RLS policy.

begin;

-- ---------------------------------------------------------------------------
-- Assignment-scoped storage helpers.

create or replace function public.crew_can_access_appointment_object(p_object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.appointment_assignments aa
    join public.staff s
      on s.id = aa.staff_id
     and s.profile_id = auth.uid()
     and s.is_active
    join public.profiles p
      on p.id = auth.uid()
     and p.active
     and p.role = 'crew'
    where aa.appointment_id::text = pg_catalog.split_part(p_object_name, '/', 1)
  );
$function$;

create or replace function public.crew_can_access_lead_object(p_object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.appointment_assignments aa
    join public.staff s
      on s.id = aa.staff_id
     and s.profile_id = auth.uid()
     and s.is_active
    join public.profiles p
      on p.id = auth.uid()
     and p.active
     and p.role = 'crew'
    join public.appointments a on a.id = aa.appointment_id
    where a.lead_id::text = pg_catalog.split_part(p_object_name, '/', 1)
  );
$function$;

create or replace function public.crew_can_access_survey_object(p_object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.appointment_assignments aa
    join public.staff s
      on s.id = aa.staff_id
     and s.profile_id = auth.uid()
     and s.is_active
    join public.profiles p
      on p.id = auth.uid()
     and p.active
     and p.role = 'crew'
    join public.appointments a on a.id = aa.appointment_id
    join public.surveys survey
      on survey.id::text = pg_catalog.split_part(p_object_name, '/', 1)
     and (a.survey_id = survey.id or (survey.lead_id is not null and a.lead_id = survey.lead_id))
  );
$function$;

revoke all on function public.crew_can_access_appointment_object(text) from public, anon, authenticated;
revoke all on function public.crew_can_access_lead_object(text) from public, anon, authenticated;
revoke all on function public.crew_can_access_survey_object(text) from public, anon, authenticated;
grant execute on function public.crew_can_access_appointment_object(text) to authenticated, service_role;
grant execute on function public.crew_can_access_lead_object(text) to authenticated, service_role;
grant execute on function public.crew_can_access_survey_object(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Profiles: self-read is needed to bootstrap the app session.  Profile writes
-- are admin-only; normal team/profile changes already use the service-role
-- action.  In particular, an inactive user cannot reactivate themselves and a
-- crew user cannot promote their own role.

drop policy if exists profiles_read on public.profiles;
drop policy if exists profiles_self on public.profiles;
drop policy if exists profiles_update on public.profiles;

create policy profiles_read on public.profiles for select
  using (public.is_office() or id = auth.uid());
create policy profiles_update on public.profiles for update
  using (public.is_admin())
  with check (public.is_admin());

-- Staff contains private roster notes/contact data and legacy rate fields. Crew
-- may read only the row linked to their login (or the still-unlinked row whose
-- email matches while first signing in). The existing first-login self-link is
-- retained, but a trigger makes that the ONLY non-admin update shape.
drop policy if exists staff_read on public.staff;
create policy staff_read on public.staff for select using (
  public.is_office()
  or (
    public.is_staff()
    and (
      profile_id = auth.uid()
      or (profile_id is null and email is not null and pg_catalog.lower(email) = public.my_email())
    )
  )
);

create or replace function public.enforce_staff_self_link_only()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  -- Direct database/service-role work has no end-user uid and already sits
  -- outside authenticated RLS. Admin roster edits are legitimate.
  if auth.uid() is null or public.is_admin() then
    return new;
  end if;

  if old.profile_id is null
     and new.profile_id = auth.uid()
     and public.is_staff()
     and old.email is not null
     and pg_catalog.lower(old.email) = public.my_email()
     and (pg_catalog.to_jsonb(new) - 'profile_id' - 'updated_at')
         = (pg_catalog.to_jsonb(old) - 'profile_id' - 'updated_at') then
    return new;
  end if;

  raise exception 'Only the matching first-login staff link may be changed'
    using errcode = '42501';
end;
$function$;

revoke all on function public.enforce_staff_self_link_only() from public, anon, authenticated;
drop trigger if exists trg_staff_self_link_guard on public.staff;
create trigger trg_staff_self_link_guard
  before update on public.staff
  for each row execute function public.enforce_staff_self_link_only();

-- ---------------------------------------------------------------------------
-- CRM reads and writes are office-only.  Destructive deletes on the original
-- CRM tables remain admin-only; that is intentionally stricter than office.

drop policy if exists clients_read on public.clients;
drop policy if exists clients_insert on public.clients;
drop policy if exists clients_update on public.clients;
drop policy if exists clients_delete on public.clients;
create policy clients_read on public.clients for select using (public.is_office());
create policy clients_insert on public.clients for insert with check (public.is_office());
create policy clients_update on public.clients for update using (public.is_office()) with check (public.is_office());
create policy clients_delete on public.clients for delete using (public.is_admin());

drop policy if exists leads_read on public.leads;
drop policy if exists leads_insert on public.leads;
drop policy if exists leads_update on public.leads;
drop policy if exists leads_delete on public.leads;
create policy leads_read on public.leads for select using (public.is_office());
create policy leads_insert on public.leads for insert with check (public.is_office());
create policy leads_update on public.leads for update using (public.is_office()) with check (public.is_office());
create policy leads_delete on public.leads for delete using (public.is_admin());

drop policy if exists appointments_read on public.appointments;
drop policy if exists appointments_insert on public.appointments;
drop policy if exists appointments_update on public.appointments;
drop policy if exists appointments_delete on public.appointments;
create policy appointments_read on public.appointments for select using (public.is_office());
create policy appointments_insert on public.appointments for insert with check (public.is_office());
create policy appointments_update on public.appointments for update using (public.is_office()) with check (public.is_office());
create policy appointments_delete on public.appointments for delete using (public.is_admin());

drop policy if exists appointment_assignments_read on public.appointment_assignments;
drop policy if exists appointment_assignments_insert on public.appointment_assignments;
drop policy if exists appointment_assignments_update on public.appointment_assignments;
drop policy if exists appointment_assignments_delete on public.appointment_assignments;
create policy appointment_assignments_read on public.appointment_assignments for select using (public.is_office());
create policy appointment_assignments_insert on public.appointment_assignments for insert with check (public.is_office());
create policy appointment_assignments_update on public.appointment_assignments for update using (public.is_office()) with check (public.is_office());
create policy appointment_assignments_delete on public.appointment_assignments for delete using (public.is_office());

-- Fleet roster writes were deliberately made admin-only in 0067; preserve that
-- stricter rule while removing crew-wide vehicle enumeration.
drop policy if exists vehicles_read on public.vehicles;
drop policy if exists vehicles_insert on public.vehicles;
drop policy if exists vehicles_update on public.vehicles;
drop policy if exists vehicles_delete on public.vehicles;
create policy vehicles_read on public.vehicles for select using (public.is_office());
create policy vehicles_insert on public.vehicles for insert with check (public.is_admin());
create policy vehicles_update on public.vehicles for update using (public.is_admin()) with check (public.is_admin());
create policy vehicles_delete on public.vehicles for delete using (public.is_admin());

drop policy if exists surveys_read on public.surveys;
drop policy if exists surveys_insert on public.surveys;
drop policy if exists surveys_update on public.surveys;
drop policy if exists surveys_delete on public.surveys;
create policy surveys_read on public.surveys for select using (public.is_office());
create policy surveys_insert on public.surveys for insert with check (public.is_office());
create policy surveys_update on public.surveys for update using (public.is_office()) with check (public.is_office());
create policy surveys_delete on public.surveys for delete using (public.is_admin());

drop policy if exists survey_photos_read on public.survey_photos;
drop policy if exists survey_photos_insert on public.survey_photos;
drop policy if exists survey_photos_update on public.survey_photos;
drop policy if exists survey_photos_delete on public.survey_photos;
create policy survey_photos_read on public.survey_photos for select using (public.is_office());
create policy survey_photos_insert on public.survey_photos for insert with check (public.is_office());
create policy survey_photos_update on public.survey_photos for update using (public.is_office()) with check (public.is_office());
create policy survey_photos_delete on public.survey_photos for delete using (public.is_admin());

drop policy if exists communications_read on public.communications;
drop policy if exists communications_insert on public.communications;
drop policy if exists communications_update on public.communications;
drop policy if exists communications_delete on public.communications;
create policy communications_read on public.communications for select using (public.is_office());
create policy communications_insert on public.communications for insert with check (public.is_office());
create policy communications_update on public.communications for update using (public.is_office()) with check (public.is_office());
create policy communications_delete on public.communications for delete using (public.is_admin());

drop policy if exists activities_read on public.activities;
drop policy if exists activities_insert on public.activities;
drop policy if exists activities_update on public.activities;
drop policy if exists activities_delete on public.activities;
create policy activities_read on public.activities for select using (public.is_office());
create policy activities_insert on public.activities for insert with check (public.is_office());
create policy activities_update on public.activities for update using (public.is_office()) with check (public.is_office());
create policy activities_delete on public.activities for delete using (public.is_admin());

-- Later feature migrations added more staff-wide policies after the original
-- CRM loop. Crew access to these records is now mediated by assignment/self-
-- scoped server actions, so direct PostgREST access is office-only.
drop policy if exists events_insert on public.events_log;
create policy events_insert on public.events_log for insert with check (public.is_office());

drop policy if exists follow_ups_read on public.follow_ups;
drop policy if exists follow_ups_insert on public.follow_ups;
drop policy if exists follow_ups_update on public.follow_ups;
create policy follow_ups_read on public.follow_ups for select using (public.is_office());
create policy follow_ups_insert on public.follow_ups for insert with check (public.is_office());
create policy follow_ups_update on public.follow_ups for update using (public.is_office()) with check (public.is_office());

drop policy if exists job_completions_read on public.job_completions;
drop policy if exists job_completions_insert on public.job_completions;
create policy job_completions_read on public.job_completions for select using (public.is_office());
create policy job_completions_insert on public.job_completions for insert with check (public.is_office());

drop policy if exists job_notes_read on public.job_notes;
drop policy if exists job_notes_insert on public.job_notes;
create policy job_notes_read on public.job_notes for select using (public.is_office());
create policy job_notes_insert on public.job_notes for insert with check (public.is_office());

drop policy if exists job_media_read on public.job_media;
drop policy if exists job_media_insert on public.job_media;
create policy job_media_read on public.job_media for select using (public.is_office());
create policy job_media_insert on public.job_media for insert with check (public.is_office());

drop policy if exists signatures_read on public.signatures;
drop policy if exists signatures_insert on public.signatures;
create policy signatures_read on public.signatures for select using (public.is_office());
create policy signatures_insert on public.signatures for insert with check (public.is_office());

drop policy if exists storage_sites_read on public.storage_sites;
drop policy if exists storage_sites_insert on public.storage_sites;
drop policy if exists storage_sites_update on public.storage_sites;
create policy storage_sites_read on public.storage_sites for select using (public.is_office());
create policy storage_sites_insert on public.storage_sites for insert with check (public.is_office());
create policy storage_sites_update on public.storage_sites for update using (public.is_office()) with check (public.is_office());

drop policy if exists storage_units_read on public.storage_units;
drop policy if exists storage_units_insert on public.storage_units;
drop policy if exists storage_units_update on public.storage_units;
create policy storage_units_read on public.storage_units for select using (public.is_office());
create policy storage_units_insert on public.storage_units for insert with check (public.is_office());
create policy storage_units_update on public.storage_units for update using (public.is_office()) with check (public.is_office());

drop policy if exists vehicle_reminder_log_read on public.vehicle_reminder_log;
create policy vehicle_reminder_log_read on public.vehicle_reminder_log for select using (public.is_office());
drop policy if exists vehicle_unavailability_read on public.vehicle_unavailability;
create policy vehicle_unavailability_read on public.vehicle_unavailability for select using (public.is_office());

-- ---------------------------------------------------------------------------
-- Storage: office can read/upload throughout; crew can read/upload only below
-- an assigned appointment/lead/survey prefix.  Direct deletes stay office-only
-- (crew deletion flows are server actions with their own ownership checks).

drop policy if exists job_photos_read on storage.objects;
drop policy if exists job_photos_write on storage.objects;
drop policy if exists job_photos_delete on storage.objects;
create policy job_photos_read on storage.objects for select using (
  bucket_id = 'job-photos'
  and (public.is_office() or public.crew_can_access_appointment_object(name))
);
create policy job_photos_write on storage.objects for insert with check (
  bucket_id = 'job-photos'
  and (public.is_office() or public.crew_can_access_appointment_object(name))
);
create policy job_photos_delete on storage.objects for delete using (
  bucket_id = 'job-photos' and public.is_office()
);

drop policy if exists job_media_obj_read on storage.objects;
drop policy if exists job_media_obj_write on storage.objects;
drop policy if exists job_media_obj_delete on storage.objects;
create policy job_media_obj_read on storage.objects for select using (
  bucket_id = 'job-media'
  and (public.is_office() or public.crew_can_access_lead_object(name))
);
create policy job_media_obj_write on storage.objects for insert with check (
  bucket_id = 'job-media'
  and (public.is_office() or public.crew_can_access_lead_object(name))
);
create policy job_media_obj_delete on storage.objects for delete using (
  bucket_id = 'job-media' and public.is_office()
);

drop policy if exists survey_photos_read on storage.objects;
drop policy if exists survey_photos_write on storage.objects;
drop policy if exists survey_photos_delete on storage.objects;
create policy survey_photos_read on storage.objects for select using (
  bucket_id = 'survey-photos'
  and (public.is_office() or public.crew_can_access_survey_object(name))
);
create policy survey_photos_write on storage.objects for insert with check (
  bucket_id = 'survey-photos'
  and (public.is_office() or public.crew_can_access_survey_object(name))
);
create policy survey_photos_delete on storage.objects for delete using (
  bucket_id = 'survey-photos' and public.is_office()
);

notify pgrst, 'reload schema';

commit;
