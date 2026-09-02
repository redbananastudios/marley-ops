-- 0116: take back the crate lets 0115's backfill flipped but should not have.
--
-- 0115's guard (b) excluded a let whose customer signed the v1 28-day terms by
-- testing `terms_version like 'storage-terms-v1%'`. That recognises a stamp by
-- the one shape it knows, and every storage signature taken before the first
-- published storage terms (2026-08-11) carries neither: either the retired
-- hand-maintained constant, or NULL for the rows scripts/backfill-signature-terms.mjs
-- deliberately SKIPs because no version was live the day they were signed. For
-- both, the LIKE is false or NULL, `not exists` is therefore TRUE, and the let
-- was flipped — the exact cohort guard (b) names as the one to leave alone.
--
-- The cost is not cosmetic. crateMinimumEnd then returns a ~31-day window while
-- the minimum invoice already raised keeps its 28-day period_end, so the arrears
-- cursor restarts past days nobody has billed and nobody ever will (the
-- period_start claim key means the old window cannot be re-raised). The /s page
-- and the ack, both driven off min_kind, start reading "one calendar month
-- minimum" against a document whose own clause says a minimum period of 28 days.
--
-- So the test is inverted here: a let keeps the calendar-month window only when
-- its storage signature is DEMONSTRABLY from the calendar-month family (v2, the
-- 2026-08-31 rewrite, and any later version of it). A stamp that is NULL,
-- retired, or v1 means the customer signed a day-count minimum, whatever the
-- string happens to read. A let with no storage signature at all is untouched —
-- 0115 flipped it on the reasoning that it will sign v2+ when the signature is
-- collected, and that reasoning still holds.
--
-- Guard (a)'s cohort is out of reach by construction: a let with arrears in
-- motion was never flipped, so it is not on 'calendar_month' to take back.

update storage_lets l
   set min_kind = 'days'
 where l.billing_model = 'crate_daily'
   and l.min_kind = 'calendar_month'
   and exists (
         select 1 from signatures s
          where s.storage_let_id = l.id
            and s.kind = 'storage'
            and (s.terms_version is null
                 or s.terms_version !~ '^storage-terms-v([2-9]|[1-9][0-9])-'));
