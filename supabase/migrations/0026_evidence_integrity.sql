-- 0026: evidence integrity (final-pass audit, 2026-07-10).
--
-- 1. job_completions.appointment_id was ON DELETE CASCADE — deleting a removal
--    appointment silently destroyed the signed completion (signatures,
--    exceptions, certificate pointer). Evidence must outlive the diary row:
--    RESTRICT, and the app explains ("this job has a signed completion").
-- 2. client_id lands on both evidence tables (backfilled from the lead) so the
--    client record can roll up its paperwork directly — and so future
--    kind='storage' agreements (which have no quote) still anchor to a client.

alter table job_completions drop constraint job_completions_appointment_id_fkey;
alter table job_completions
  add constraint job_completions_appointment_id_fkey
  foreign key (appointment_id) references appointments(id) on delete restrict;

alter table signatures      add column if not exists client_id uuid references clients(id) on delete set null;
alter table job_completions add column if not exists client_id uuid references clients(id) on delete set null;

update signatures s set client_id = l.client_id
  from leads l where s.lead_id = l.id and s.client_id is null;
update job_completions j set client_id = l.client_id
  from leads l where j.lead_id = l.id and j.client_id is null;

create index if not exists signatures_client_idx      on signatures(client_id);
create index if not exists job_completions_client_idx on job_completions(client_id);
