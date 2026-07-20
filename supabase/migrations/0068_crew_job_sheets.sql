-- Night-before crew job-sheet delivery (crew-reliability PRD, A1). Each crew
-- member gets a PDF day-sheet emailed + an SMS link to a login-less web copy at
-- 18:00 the evening before. crew_job_sheets holds the CURRENT state per crew
-- member per work-date (version + content hash + the stable share token, so a
-- job change is detected and re-sent superseding the old copy). Every send
-- attempt is appended to crew_job_sheet_sends for the office audit / failure
-- surface. Writes are service-role only (the cron uses the admin client);
-- office can read both for the delivery log.

-- Current state per crew member per work-date. One row; version bumps in place
-- when the assembled sheet content changes.
create table public.crew_job_sheets (
  id            uuid primary key default gen_random_uuid(),
  staff_id      uuid not null references public.staff(id) on delete cascade,
  work_date     date not null,
  version       integer not null default 1,
  -- Hash of the CURRENT assembled sheet content we're trying to deliver. A job
  -- change flips this and triggers a superseding re-send.
  content_hash  text not null,
  -- Hash of the content we last SUCCESSFULLY delivered (>=1 channel). While it
  -- lags content_hash the cron keeps (re)sending — so a transient email/SMS
  -- failure is retried, but delivered content is never re-sent.
  delivered_hash text,
  delivered_at   timestamptz,
  -- Send attempts for the current content_hash (capped so a hard failure like a
  -- bad address stops re-trying but stays visible in the failure log).
  attempts      integer not null default 0,
  -- Unguessable credential for /sheet/<token> (randomBytes(18).base64url = 24
  -- chars). Stable across versions so an SMS'd/bookmarked link always resolves
  -- to the latest sheet.
  token         text not null unique,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (staff_id, work_date)
);
create index crew_job_sheets_work_date_idx on public.crew_job_sheets (work_date);
create trigger trg_crew_job_sheets_updated
  before update on public.crew_job_sheets
  for each row execute function public.set_updated_at();

-- Append-only log of every delivery attempt (email + SMS, initial + re-sends).
create table public.crew_job_sheet_sends (
  id           uuid primary key default gen_random_uuid(),
  sheet_id     uuid not null references public.crew_job_sheets(id) on delete cascade,
  version      integer not null,
  channel      text not null check (channel in ('email','sms')),
  status       text not null check (status in ('sent','failed','skipped')),
  -- true when this send supersedes an earlier version (a job changed after the
  -- first send) — lets the office tell a first send from a correction.
  superseding  boolean not null default false,
  recipient    text,          -- email address / phone actually used
  provider_id  text,          -- Resend / WebEx transaction id
  error        text,          -- populated when status = 'failed'
  created_at   timestamptz not null default now()
);
create index crew_job_sheet_sends_sheet_idx on public.crew_job_sheet_sends (sheet_id, created_at desc);
create index crew_job_sheet_sends_created_idx on public.crew_job_sheet_sends (created_at desc);
create index crew_job_sheet_sends_failed_idx
  on public.crew_job_sheet_sends (created_at desc) where status = 'failed';

-- Office (admin | estimator) can read the delivery log; the service role
-- (cron, admin client) is the only writer — no client insert/update policy, so
-- PostgREST callers can't forge a send row.
alter table public.crew_job_sheets enable row level security;
alter table public.crew_job_sheet_sends enable row level security;

create policy crew_job_sheets_read on public.crew_job_sheets for select using (is_office());
create policy crew_job_sheet_sends_read on public.crew_job_sheet_sends for select using (is_office());
