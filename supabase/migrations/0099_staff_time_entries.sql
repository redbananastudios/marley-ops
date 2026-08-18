-- 0099: crew daily time entries + expense repayments.
--
-- Crew log a start and finish per worked day — after the fact, any time up to
-- invoicing, never a punch clock (Peter, 2026-08-18: hours are variable, "we
-- cant say that they are doing 8 hours daily"). Hours are the straight
-- finish − start, lunch included. Each day can carry ONE repayable expense
-- (fuel etc.), paid back at cost on the same weekly invoice; its receipt photo
-- is stored privately and emailed to the accounts@ money desk.
--
-- Deliberately a SEPARATE table from staff_availability: availability is the
-- forward plan ("can we take this job"), a time entry is the backward record
-- ("what did this day cost"). One row per staff member per day.

create table public.staff_time_entries (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.staff (id) on delete cascade,
  work_date date not null,
  -- Times of day ("08:00"). Nullable so a day can hold an expense alone
  -- (a fuel receipt on a day the hours haven't been filled in yet).
  started_at time,
  ended_at time,
  -- One repayable expense per day, at cost, capped at the same £10,000 a
  -- statement line may carry — the DB bound holds even for a direct PostgREST
  -- write, so the seed path can never launder an absurd figure onto an invoice.
  expense_amount numeric(10, 2) check (expense_amount is null or (expense_amount >= 0 and expense_amount <= 10000)),
  expense_note text,
  -- Receipt state is SERVER-ATTESTED: receipt_key is set only after the upload
  -- provably landed in storage, receipt_emailed_at only after the mail pipeline
  -- durably accepted the copy to accounts@. Crew can't write either column
  -- (see the column grants below), so neither state can be self-attested.
  receipt_key text,
  receipt_emailed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A finish at or before the start is a typo, not an overnight shift — work
  -- past midnight is logged as two days so each entry stays in its pay week.
  constraint staff_time_entries_times_check
    check (started_at is null or ended_at is null or ended_at > started_at),
  constraint staff_time_entries_one_per_day unique (staff_id, work_date)
);

create index staff_time_entries_staff_idx on public.staff_time_entries (staff_id, work_date);

create trigger trg_staff_time_entries_updated
  before update on public.staff_time_entries
  for each row execute function public.set_updated_at();

alter table public.staff_time_entries enable row level security;

-- Crew-owns-rows (staff_availability pattern, 0053) PLUS the invoice lock: once
-- a SUBMITTED or PAID statement covers a day, that day's entry is the evidence
-- behind an invoice and a crew member can no longer change it — enforced HERE
-- so a direct PostgREST call can't do what the app refuses. The office
-- (is_office) can still amend. Crew read their own statements under 0056's
-- read policy, so the subquery resolves without a definer helper.
create policy staff_time_entries_read on public.staff_time_entries for select
  using (
    is_office()
    or staff_id in (select id from public.staff where profile_id = auth.uid())
  );
create policy staff_time_entries_insert on public.staff_time_entries for insert
  with check (
    is_office()
    or (
      staff_id in (select id from public.staff where profile_id = auth.uid())
      and not exists (
        select 1 from public.staff_statements s
        where s.staff_id = staff_time_entries.staff_id
          and s.period_start <= staff_time_entries.work_date
          and s.period_end >= staff_time_entries.work_date
          and s.status in ('submitted', 'paid')
      )
    )
  );
create policy staff_time_entries_update on public.staff_time_entries for update
  using (
    is_office()
    or (
      staff_id in (select id from public.staff where profile_id = auth.uid())
      and not exists (
        select 1 from public.staff_statements s
        where s.staff_id = staff_time_entries.staff_id
          and s.period_start <= staff_time_entries.work_date
          and s.period_end >= staff_time_entries.work_date
          and s.status in ('submitted', 'paid')
      )
    )
  )
  with check (
    is_office()
    or (
      staff_id in (select id from public.staff where profile_id = auth.uid())
      and not exists (
        select 1 from public.staff_statements s
        where s.staff_id = staff_time_entries.staff_id
          and s.period_start <= staff_time_entries.work_date
          and s.period_end >= staff_time_entries.work_date
          and s.status in ('submitted', 'paid')
      )
    )
  );
create policy staff_time_entries_delete on public.staff_time_entries for delete
  using (
    is_office()
    or (
      staff_id in (select id from public.staff where profile_id = auth.uid())
      and not exists (
        select 1 from public.staff_statements s
        where s.staff_id = staff_time_entries.staff_id
          and s.period_start <= staff_time_entries.work_date
          and s.period_end >= staff_time_entries.work_date
          and s.status in ('submitted', 'paid')
      )
    )
  );

-- Column grants: the receipt columns are written only by the server (service
-- role) after real verification — take them out of the authenticated role's
-- writable set entirely. work_date/staff_id stay in the update grant because
-- PostgREST upserts SET every payload column on conflict; RLS still owns who
-- may touch which row.
revoke insert, update on public.staff_time_entries from authenticated;
grant insert (staff_id, work_date, started_at, ended_at, expense_amount, expense_note)
  on public.staff_time_entries to authenticated;
grant update (staff_id, work_date, started_at, ended_at, expense_amount, expense_note)
  on public.staff_time_entries to authenticated;

-- Private receipt-photo bucket for the SUPABASE storage driver (dev fallback /
-- staging while its R2 bucket is unprovisioned; the s3 driver treats the name
-- as a key prefix and needs none of this). Mirror of job-media (0050): staff
-- capture + view, admin delete.
insert into storage.buckets (id, name, public) values ('expense-receipts','expense-receipts', false)
  on conflict (id) do nothing;
create policy expense_receipts_obj_read   on storage.objects for select using (bucket_id = 'expense-receipts' and is_staff());
create policy expense_receipts_obj_write  on storage.objects for insert with check (bucket_id = 'expense-receipts' and is_staff());
create policy expense_receipts_obj_delete on storage.objects for delete using (bucket_id = 'expense-receipts' and is_admin());

-- Expense repayment lines on the weekly contractor invoice. Append to the FULL
-- existing source list (0064's), never the original 0056 one — dropping any
-- live value would silently un-support existing rows.
alter table public.staff_statement_lines drop constraint if exists staff_statement_lines_source_check;
alter table public.staff_statement_lines
  add constraint staff_statement_lines_source_check
  check (source in ('manual', 'job', 'retainer', 'guarantee', 'survey', 'phone_quote', 'commission', 'expense'));
