-- 0056: staff self-billing / payment statements (2026-07-18).
--
-- Crew are self-employed and NONE are VAT-registered, so this is a plain
-- buyer-created PAYMENT STATEMENT — explicitly NOT a VAT self-bill (no VAT line,
-- no VAT number, no "supplier accounts for output tax" footer). Pay is NOT
-- derivable from jobs OR availability: some crew are on a retainer and get paid
-- on days with no work (Peter, 2026-07-18). So the crew fill in their own
-- statement lines, each with a FREE DESCRIPTION — jobs can SEED suggested lines
-- but everything is editable, until we learn how Connor actually runs the
-- retainers. The crew GENERATE + SUBMIT their own statement (their action) —
-- that submit is both the "timesheet" and the IR35 self-billing mitigation.
-- Feature stays DARK behind business_settings.self_billing_enabled until the
-- signed self-billing agreement is in place.

-- Reference sequence: MMP001, MMP002 … (Marley Moves Pay). Same pattern as
-- next_quote_ref — a plain sequence, gap-tolerant and collision-proof under
-- deletes. SECURITY DEFINER only to own the sequence; the table RLS still
-- governs whether a row may be inserted, so it is not a privilege escalation.
create sequence if not exists public.staff_statement_seq as bigint start with 1 increment by 1 minvalue 1;

create or replace function public.next_statement_ref()
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
  n bigint;
begin
  n := pg_catalog.nextval('public.staff_statement_seq');
  return 'MMP' || pg_catalog.lpad(n::text, 3, '0');
end
$function$;

revoke all on function public.next_statement_ref() from public, anon;
grant execute on function public.next_statement_ref() to authenticated, service_role;

-- Statement header. RESTRICT on staff — a payment record must outlive a staff
-- edit; crew are archived (is_active=false), never hard-deleted.
create table public.staff_statements (
  id           uuid primary key default gen_random_uuid(),
  staff_id     uuid not null references public.staff(id) on delete restrict,
  ref          text not null unique,
  period_start date not null,
  period_end   date not null,
  status       text not null default 'draft' check (status in ('draft', 'submitted', 'paid', 'void')),
  total        numeric(10, 2) not null default 0,
  note         text,
  pdf_path     text,
  submitted_at timestamptz,
  paid_at      timestamptz,
  paid_method  text,
  paid_ref     text,
  created_by   uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (period_end >= period_start)
);
create index staff_statements_staff_idx on public.staff_statements (staff_id, period_start desc);
create index staff_statements_status_idx on public.staff_statements (status);
create trigger trg_staff_statements_updated
  before update on public.staff_statements
  for each row execute function public.set_updated_at();

-- Statement lines. The free `description` is the flexibility field: worked day,
-- retainer day, extra — the crew type whatever fits. `amount` is the stored line
-- total (source of truth); quantity/unit_amount are optional convenience inputs.
create table public.staff_statement_lines (
  id             uuid primary key default gen_random_uuid(),
  statement_id   uuid not null references public.staff_statements(id) on delete cascade,
  description    text not null,
  work_date      date,
  quantity       numeric(10, 2),
  unit_amount    numeric(10, 2),
  amount         numeric(10, 2) not null default 0,
  source         text not null default 'manual' check (source in ('manual', 'job', 'retainer')),
  appointment_id uuid references public.appointments(id) on delete set null,
  sort_index     int not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index staff_statement_lines_stmt_idx on public.staff_statement_lines (statement_id, sort_index);
create trigger trg_staff_statement_lines_updated
  before update on public.staff_statement_lines
  for each row execute function public.set_updated_at();

alter table public.staff_statements enable row level security;
alter table public.staff_statement_lines enable row level security;

-- Ownership: a crew member owns a statement whose staff_id is their linked staff
-- row. The staff.profile_id used here is write-protected by 0054, so it is a safe
-- auth key (same self-scope as staff_availability, 0053).

-- STATEMENTS — read own or (office) all.
create policy staff_statements_read on public.staff_statements for select
  using (is_office() or staff_id in (select id from public.staff where profile_id = auth.uid()));

-- Crew create only their OWN draft; office create for anyone.
create policy staff_statements_insert on public.staff_statements for insert
  with check (
    is_office()
    or (staff_id in (select id from public.staff where profile_id = auth.uid()) and status = 'draft')
  );

-- Crew edit only their own row WHILE it is a draft (USING draft), and may only
-- move it to draft/submitted (WITH CHECK) — so once submitted/paid the USING
-- fails and they are locked out. Office manages any statement (approve/pay/void).
create policy staff_statements_update on public.staff_statements for update
  using (
    is_office()
    or (staff_id in (select id from public.staff where profile_id = auth.uid()) and status = 'draft')
  )
  with check (
    is_office()
    or (staff_id in (select id from public.staff where profile_id = auth.uid()) and status in ('draft', 'submitted'))
  );

create policy staff_statements_delete on public.staff_statements for delete
  using (
    is_office()
    or (staff_id in (select id from public.staff where profile_id = auth.uid()) and status = 'draft')
  );

-- LINES — read follows statement ownership (any status, so crew can view a
-- submitted/paid statement's lines).
create policy staff_statement_lines_read on public.staff_statement_lines for select
  using (
    is_office()
    or statement_id in (
      select s.id
      from public.staff_statements s
      join public.staff st on st.id = s.staff_id
      where st.profile_id = auth.uid()
    )
  );

-- Lines are only WRITABLE by the office, or by the owning crew member while the
-- parent statement is still a draft (OR-ed with the read policy above, so this
-- adds no extra read access — it governs insert/update/delete).
create policy staff_statement_lines_write on public.staff_statement_lines for all
  using (
    is_office()
    or statement_id in (
      select s.id
      from public.staff_statements s
      join public.staff st on st.id = s.staff_id
      where st.profile_id = auth.uid() and s.status = 'draft'
    )
  )
  with check (
    is_office()
    or statement_id in (
      select s.id
      from public.staff_statements s
      join public.staff st on st.id = s.staff_id
      where st.profile_id = auth.uid() and s.status = 'draft'
    )
  );

-- Feature flag — dark until the signed self-billing agreement is in place.
alter table public.business_settings
  add column if not exists self_billing_enabled boolean not null default false;
