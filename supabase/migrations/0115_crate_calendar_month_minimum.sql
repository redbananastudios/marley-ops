-- 0115: the crate minimum becomes one CALENDAR month (storage-terms v2,
-- 2026-08-31, commit 1038f96 — "a minimum period of one calendar month",
-- daily to-the-day charging only AFTER that month ends).
--
-- min_kind freezes HOW a let's minimum window is measured, the same way
-- min_days/min_amount froze its length and price in 0075 — later policy or
-- rate-card changes never disturb a running let:
--   'days'           the v1 terms' fixed day count (min_days, historically 28)
--   'calendar_month' one calendar month from start_date (clamped anniversary:
--                    15 Sep -> covered through 14 Oct; 31 Jan -> 27/28 Feb),
--                    min_days ignored. lib/storage-billing.ts crateMinimumEnd
--                    is the single derivation.
--
-- Default 'days': every EXISTING row keeps its frozen 28-day behaviour bit
-- for bit. New crate lets get 'calendar_month' stamped by startLetAction.

alter table storage_lets
  add column if not exists min_kind text not null default 'days'
    check (min_kind in ('days', 'calendar_month'));

comment on column storage_lets.min_kind is
  'How the crate minimum window is measured, frozen at creation: days (v1 terms, min_days) | calendar_month (storage-terms v2, 2026-08-31).';

-- Backfill — move a crate let to the calendar-month minimum ONLY when both
-- hold:
--   (a) its daily-arrears grid is NOT yet in motion (no arrears/final
--       invoice). Re-anchoring a moving grid would re-raise days already
--       billed — the period_start claim key is the idempotency seam, and a
--       shifted cursor never matches the old claims.
--   (b) it did NOT sign the v1 28-day terms. A customer who signed
--       "28 days, daily from day 29" keeps exactly the schedule they signed;
--       everyone else either signed v2 (calendar month) or will sign v2+
--       when their signature is collected, so calendar_month is the only
--       rule consistent with their document.
--   (c) it is NOT an imported legacy let (import_batch): Pitmans-era lets
--       run on whatever their own paperwork said, encoded by the operator
--       as min_days on the import template — never our published terms.
-- A crate let that signed v2 but already has arrears on the 28-day grid is
-- deliberately LEFT on 'days' by guard (a) — flag it for a manual decision
-- rather than risk double-billing (as of 2026-09-02 the class should be
-- empty: v2 shipped 31 Aug and arrears start >= 28 days after commencement,
-- so only a backdated start_date could produce one).
update storage_lets l
   set min_kind = 'calendar_month'
 where l.billing_model = 'crate_daily'
   and l.import_batch is null
   and not exists (
         select 1 from storage_invoices i
          where i.let_id = l.id and i.kind in ('arrears', 'final'))
   and not exists (
         select 1 from signatures s
          where s.storage_let_id = l.id
            and s.kind = 'storage'
            and s.terms_version like 'storage-terms-v1%');
