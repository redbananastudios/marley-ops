-- 0061: crew HOURLY pay model (Connor + Leanne, 2026-07-19).
--
-- Replaces the flat per-day rate with an HOURLY rate + an optional weekly
-- GUARANTEE (Rob: £600/week floor, paid whether there's work or not). Crew
-- invoice lines become hours × hourly_rate — the existing quantity × unit_amount
-- shape, so the ledger maths and PDF are unchanged. For a guaranteed crew member
-- a system-managed 'guarantee' top-up line brings a light week up to the floor,
-- so sum(lines) == total everywhere (crew editor, office view, PDF).
--
-- RATE PRIVACY (Peter, 2026-07-19): rates move OFF the crew-readable `staff`
-- table into an office-scoped `staff_pay` table. A crew member can read only
-- THEIR OWN row (to pre-fill their invoice rate) and never a colleague's — and
-- can no longer self-set a rate via direct PostgREST (the 0020 staff_update RLS
-- let their own row through; 0054's with-check only pinned profile_id/email, not
-- day_rate). Office reads + writes all pay.

-- Per-staff pay, office-owned. One row per staff member (created on demand).
create table public.staff_pay (
  staff_id         uuid primary key references public.staff(id) on delete cascade,
  hourly_rate      numeric(10, 2),
  weekly_guarantee numeric(10, 2),           -- Rob = 600; null = pure hourly (paid on days worked)
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create trigger trg_staff_pay_updated before update on public.staff_pay
  for each row execute function public.set_updated_at();

alter table public.staff_pay enable row level security;

-- Office reads + writes all pay. A crew member may READ ONLY their own row (to
-- pre-fill their own invoice rate) and never write — this IS the rate-privacy
-- guarantee: a colleague's rate is unreadable, and a crew login cannot self-set
-- a rate via the raw API.
create policy staff_pay_read on public.staff_pay for select
  using (is_office() or staff_id in (select id from public.staff where profile_id = auth.uid()));
create policy staff_pay_write on public.staff_pay for all
  using (is_office())
  with check (is_office());

-- Allow the system-managed 'guarantee' top-up line (weekly minimum for a
-- guaranteed crew member). Recreate the source check to include it.
alter table public.staff_statement_lines drop constraint if exists staff_statement_lines_source_check;
alter table public.staff_statement_lines
  add constraint staff_statement_lines_source_check
  check (source in ('manual', 'job', 'retainer', 'guarantee'));

-- Retire the now-unused per-day rate on the crew-readable `staff` table so no
-- rate data remains where a colleague could read it. Column kept (types) but
-- emptied; new pay lives in staff_pay.
update public.staff set day_rate = null where day_rate is not null;
