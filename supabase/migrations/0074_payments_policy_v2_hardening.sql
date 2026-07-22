-- 0074: Payments Policy v2 hardening — review findings applied (2026-07-22).
--
-- 1) refund_queue gains two terminal statuses:
--      'released'   a customer_date_change row whose old day re-booked (or had
--                   nothing retainable) — the held money simply KEEPS counting
--                   toward the rebooked job. Nothing pays out, no refund email.
--      'superseded' a pending row closed because a later trigger event
--                   (e.g. an outright cancel after a date change) re-snapshotted
--                   the same lead's held money into a fresh row. The new row is
--                   the live decision; the superseded row stays as history.
-- 2) One live refund decision per lead, DB-enforced: overlapping pending rows
--    were the double-refund exposure (the same held money snapshotted twice,
--    each row independently demanding a full payout on the bank/cash rails).
-- 3) Bank/cash payout marks become single-winner at the DB: a unique index on
--    (entity, rail) for 'rail_refunded' events turns a photo-finish double
--    press into a clean 23505 the action reports as "already recorded".
-- 4) refund_queue read RLS tightens is_office() -> is_admin(): the PRD says
--    "crew/estimator: zero rows", the /refunds page + every action are
--    admin-only, and the table carries customers' bank account numbers
--    (cash_recipient_*). Exact precedent: 0063 (staff_pay), 0065 (estimator
--    invoicing) — staff-scoped RLS must never be weaker than the UI gate.
-- 5) quotes.booking_cancelled_at — the cancellation marker for money surfaces.
--    A Marley cancel (and the mark-lost unwind) stamps it so /q stops
--    soliciting payment against voided invoices and the chase cron's
--    commitment sweep / T-7 flag go quiet on a booking that no longer exists.

-- ---------------------------------------------------------- 1) new statuses
alter table public.refund_queue drop constraint if exists refund_queue_status_check;
alter table public.refund_queue add constraint refund_queue_status_check
  check (status in ('pending', 'refunded', 'retained', 'released', 'superseded'));

-- ------------------------------------------------ 2) one pending row per lead
create unique index if not exists refund_queue_one_pending_per_lead
  on public.refund_queue (lead_id)
  where status = 'pending' and lead_id is not null;

-- ---------------------------------------- 3) single-winner rail payout marks
create unique index if not exists events_rail_refunded_uq
  on public.events_log (entity_type, entity_id, ((diff->>'rail')))
  where action = 'rail_refunded';

-- --------------------------------------------------------- 4) admin-only read
drop policy if exists refund_queue_read on public.refund_queue;
create policy refund_queue_read on public.refund_queue
  for select using (is_admin());

-- ------------------------------------------------- 5) cancellation marker
alter table public.quotes
  add column if not exists booking_cancelled_at timestamptz;

comment on column public.quotes.booking_cancelled_at is
  'Stamped when the booking behind this accepted quote is cancelled (Marley cancel or mark-lost). Money surfaces (/q payment panels, commitment chase + T-7 flag, post-move sweep) must treat the quote as dead. Cleared if the lead is reopened.';
