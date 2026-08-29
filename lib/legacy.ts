/**
 * IMPORTED bookings are hard-excluded from automated customer email and
 * money automation (migration 0088): they were sold under the old system's
 * terms, and the panel must never send them correspondence they didn't agree
 * to (chases, commitment invoicing, the T-7 final invoice).
 *
 * Two source systems qualify. iMVE came across on 2026-08-13; Pitmans forward
 * bookings arrive at the September takeover (PRD gate 20) having been sold by
 * Mark under HIS terms, to customers who have never heard from Marley at all.
 * The first contact from a new owner must not be an automated payment demand,
 * so both sit behind this one lock rather than each rail learning the rule.
 *
 * `standard_comms_at` (migration 0094) lifts that lock per booking. The office
 * sets it AFTER the customer has been informed by phone — Luke's call ~8-9
 * days before the move — and from that moment the booking behaves like any
 * other for email/money automation.
 *
 * Two things deliberately do NOT change with the toggle:
 *  - Crew paperwork surfaces (contract-signature nags on the schedule, board,
 *    crew sheets, documents, dashboard tile) stay keyed on the SOURCE alone,
 *    via importedBooking() below: those customers signed the other system's
 *    paperwork, and a phone call doesn't create a Marley contract for the crew
 *    to collect. That rule is never lifted, which is why it is a separate
 *    predicate rather than legacyLocked with the toggle ignored.
 *  - No commitment invoice is invented retroactively: ensureCommitmentInvoice
 *    only fires from the date-confirmation flow, which imported (already
 *    date-confirmed) bookings never traverse.
 */
export interface LegacyLockFields {
  source: string | null;
  standard_comms_at: string | null;
}

/**
 * Sources whose bookings were sold under ANOTHER system's terms, so the panel
 * owes their customers silence until a human has spoken to them.
 */
export const IMPORTED_SOURCES = ["imve", "pitmans"] as const;

/**
 * The same list as a PostgREST `in` value, for the two queries that must
 * exclude imported bookings in the DATABASE rather than after the read:
 * `.not("source", "in", IMPORTED_SOURCES_SQL)`. Derived from the array above
 * so the two can never drift - which matters, because a stale literal here
 * fails open, telling the crew to collect a contract that does not exist.
 */
export const IMPORTED_SOURCES_SQL = `(${IMPORTED_SOURCES.join(",")})`;

/**
 * True when a booking came from another system's books at all.
 *
 * Unlike legacyLocked this is NEVER lifted: standard_comms_at says a human has
 * phoned the customer about their MOVE, which does not retroactively produce a
 * signed Marley contract for the crew to collect. Paperwork surfaces use this;
 * money and comms use legacyLocked.
 */
export const importedBooking = (source: string | null): boolean =>
  IMPORTED_SOURCES.includes(source as (typeof IMPORTED_SOURCES)[number]);

/** True while automated customer email/money machinery must skip this quote. */
export const legacyLocked = (q: LegacyLockFields): boolean =>
  importedBooking(q.source) && !q.standard_comms_at;
