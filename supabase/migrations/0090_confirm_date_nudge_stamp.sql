-- Separate the two T-10 one-shots.
--
-- `commitment_chase_t10_at` was doing double duty: it gated BOTH the internal
-- "call them, the date isn't confirmed" task (date not yet confirmed) AND the
-- customer-facing commitment reminder email (date confirmed, 25% invoiced and
-- unpaid). Whichever fired first consumed the stamp for the other.
--
-- In practice the internal one fires first — an unconfirmed date at T-10 is
-- exactly the state that precedes confirmation — so a customer who then
-- confirmed their date and was invoiced 25% NEVER received the reminder about
-- it. Worse, the T-7 "date at risk" alert takes its grace anchor from the same
-- stamp and tells the office "their commitment reminder went out on <date> and
-- there's been no payment since", which was simply untrue: only an internal call
-- task had been raised.
--
-- Giving the confirm-date nudge its own stamp lets each fire exactly once,
-- independently, and restores the T-7 anchor to meaning what it says.

alter table quotes
  add column if not exists date_confirm_nudge_at timestamptz;

comment on column quotes.date_confirm_nudge_at is
  'One-shot marker for the internal "confirm the move date" call task at T-10. Separate from commitment_chase_t10_at, which marks the CUSTOMER commitment reminder.';

-- Backfill: existing rows whose stamp was consumed by the confirm-date variant
-- cannot be distinguished from a genuine chase after the fact, so they are left
-- alone. Only future runs get the corrected behaviour — no retro-emailing of
-- customers whose move has already happened.

notify pgrst, 'reload schema';
