-- Per-booking "standard comms" switch for legacy iMVE bookings (Peter, 2026-08-13).
--
-- Migration 0088 hard-excludes source='imve' quotes from all automated customer
-- email and money automation: those customers booked under the old system's
-- terms and must never receive correspondence they didn't agree to. The office
-- is now phoning each legacy customer ~8-9 days before their move (Luke) to
-- bring them onto the current arrangements.
--
-- standard_comms_at records that call. Null = still locked (0088 behaviour).
-- Set = from this moment the booking is treated like any other for EMAIL and
-- money automation (commitment machinery, T-7 final invoice). Crew paperwork
-- surfaces (contract-signature nags on schedule/board/crew sheets/documents)
-- deliberately stay keyed on source='imve' — legacy customers signed the old
-- system's paperwork; a phone call doesn't create a Marley contract to collect.
alter table quotes add column if not exists standard_comms_at timestamptz;

comment on column quotes.standard_comms_at is
  'Legacy iMVE bookings only: set when the office has informed the customer by phone that standard automated comms now apply. Null keeps the 0088 hard-exclusion.';
