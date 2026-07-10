-- 0028: crew notes + photos on jobs (Peter, 2026-07-10 — "crew may want to
-- highlight issues with damages on completion or pictures for internal
-- records").
--
--  job_notes   free-form crew observations with optional photos, written from
--              the crew job page. Anchored to lead + client as well as the
--              appointment so the record survives a diary row being deleted
--              (same evidence-integrity thinking as 0026). Internal-only:
--              never printed on the job sheet, never emailed to the customer.
--
-- Photos live in the private job-photos bucket at <appointment_id>/<uuid>.<ext>
-- and are referenced by path on the note row (immutable once attached).
-- Delete stays admin-only at the DB layer; the app additionally lets the
-- author or the office remove a note via the service role (notes are internal
-- records, not signed evidence — typos on a van tablet must be fixable).

create table job_notes (
  id             uuid primary key default gen_random_uuid(),
  appointment_id uuid references appointments(id) on delete set null,
  lead_id        uuid references leads(id) on delete set null,
  client_id      uuid references clients(id) on delete set null,
  author_id      uuid references profiles(id) on delete set null,
  author_name    text not null,
  body           text not null default '',
  photo_paths    text[] not null default '{}',
  created_at     timestamptz not null default now(),
  -- A note must say or show something.
  constraint job_notes_has_content
    check (length(btrim(body)) > 0 or coalesce(array_length(photo_paths, 1), 0) > 0)
);

create index job_notes_appt_idx   on job_notes(appointment_id);
create index job_notes_lead_idx   on job_notes(lead_id);
create index job_notes_client_idx on job_notes(client_id);

alter table job_notes enable row level security;

create policy job_notes_read   on job_notes for select using (is_staff());
create policy job_notes_insert on job_notes for insert with check (is_staff());
create policy job_notes_delete on job_notes for delete using (is_admin());

-- Private bucket for crew job photos (mirror of survey-photos policies:
-- any active staff member can upload/view, only admin deletes directly).
insert into storage.buckets (id, name, public) values ('job-photos','job-photos', false)
on conflict (id) do nothing;

create policy job_photos_read   on storage.objects for select using (bucket_id = 'job-photos' and is_staff());
create policy job_photos_write  on storage.objects for insert with check (bucket_id = 'job-photos' and is_staff());
create policy job_photos_delete on storage.objects for delete using (bucket_id = 'job-photos' and is_admin());
