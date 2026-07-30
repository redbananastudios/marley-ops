-- 0083: first-class packing days (Peter, 2026-07-30; design doc D-decisions).
-- A pack day is a crew-only appointment (van optional) attached to the same
-- lead as its removal: appt_type 'pack'. No new tables — packs reuse
-- appointments + appointment_assignments wholesale, so the Job Board, crew
-- sheets, capacity grading and the cancel flow all pick them up.

alter type appt_type add value if not exists 'pack';

-- One SCHEDULED pack per lead, enforced in the DB (the app's create/edit paths
-- upsert, but select-then-insert races would otherwise mint duplicates that
-- double-count crew capacity). Same pattern as signatures_contract_uq /
-- card_payments_one_pending_per_quote.
create unique index if not exists appointments_one_scheduled_pack_per_lead
  on appointments (lead_id)
  where appt_type = 'pack' and status = 'scheduled';
