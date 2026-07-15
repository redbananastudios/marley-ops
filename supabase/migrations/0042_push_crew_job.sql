-- 0042: crew job-assignment pushes (Peter, 2026-07-15 — "we do need push
-- notifications to crew when a new job is allocated, or when they are removed
-- from a job"). Adds the per-category kill switch for the new crew_job
-- category; the tables from 0041 already carry everything else (crew logins
-- are auth users, staff.profile_id is the linkage).
alter table business_settings
  add column push_crew_job_enabled boolean not null default true;
