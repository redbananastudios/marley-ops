-- 0080: Schedule & Allocation foundation (additive; see docs/schedule-allocation-design.md).
--
-- Everything here is ADDITIVE — a new defaulted column + a new side-table — so no existing
-- row changes behaviour and there is NO backfill. Date-certainty (approximate / provisional /
-- confirmed) is DERIVED at read time from signals that already exist (deposit paid, a
-- provisional date, the 25% commitment `commitment_paid_at`, and the confirmed removal
-- appointment). Only the genuinely-new operator fields are stored, in booking_details.

-- (a) Driver capability on crew (design §D12). A per-person capability flag the office sets,
-- deliberately ORTHOGONAL to staff_role (whose existing, unused 'driver' value conflates role
-- with capability). is_driver = true means this person can take a van out.
alter table public.staff add column if not exists is_driver boolean not null default false;

-- (b) booking_details — the date-certainty / property fields that do not exist today. One row
-- per lead's move (1:1 for now; a full multi-move bookings entity is a deliberate later
-- refactor for commercial clients). leads / quotes / appointments are untouched and remain the
-- source of truth for money and the diary; this table only holds the NEW fields.
create table if not exists public.booking_details (
  lead_id          uuid primary key references public.leads(id) on delete cascade,
  approx_window    text,            -- free-text label, e.g. "mid-August"
  approx_month     date,            -- 1st-of-month, for grouping / sorting the demand panel
  provisional_date date,            -- a guessed date, OFF the diary (no appointment yet)
  property_type    text check (property_type in ('homeowner','rented')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- RLS mirrors the appointments / 0067 office-managed pattern.
alter table public.booking_details enable row level security;
create policy booking_details_read   on public.booking_details for select using (is_office());
create policy booking_details_insert on public.booking_details for insert with check (is_office());
create policy booking_details_update on public.booking_details for update using (is_office()) with check (is_office());
create policy booking_details_delete on public.booking_details for delete using (is_admin());

create trigger trg_booking_details_updated before update on public.booking_details
  for each row execute function set_updated_at();
