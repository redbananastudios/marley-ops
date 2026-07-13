-- Automation audit log: one row per cron/scheduled-job run, written by the
-- runCron() wrapper (lib/cron/run-logger.ts). Powers the /automations page so
-- the office can see every automation that has fired, its outcome, and what it
-- did — and so a failing job is visible instead of silent.

create table if not exists public.cron_runs (
  id           uuid primary key default gen_random_uuid(),
  job          text not null,                       -- stable job slug, e.g. 'chase'
  status       text not null check (status in ('ok', 'error', 'skipped')),
  started_at   timestamptz not null,
  finished_at  timestamptz not null default now(),
  duration_ms  integer,
  summary      jsonb not null default '{}'::jsonb,  -- the job's own result object
  error        text,                                -- message when status = 'error'
  created_at   timestamptz not null default now()
);

create index if not exists cron_runs_job_started_idx on public.cron_runs (job, started_at desc);
create index if not exists cron_runs_started_idx on public.cron_runs (started_at desc);

-- Office (admin | estimator) can read the log; only the service role writes it
-- (crons use the admin client, which bypasses RLS). No client ever inserts here.
alter table public.cron_runs enable row level security;

drop policy if exists cron_runs_read on public.cron_runs;
create policy cron_runs_read on public.cron_runs for select using (is_office());
