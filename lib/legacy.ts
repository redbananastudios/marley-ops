/**
 * Legacy iMVE bookings are hard-excluded from automated customer email and
 * money automation (migration 0088): they were sold under the old system's
 * terms, and the panel must never send them correspondence they didn't agree
 * to (chases, commitment invoicing, the T-7 final invoice).
 *
 * `standard_comms_at` (migration 0094) lifts that lock per booking. The office
 * sets it AFTER the customer has been informed by phone — Luke's call ~8-9
 * days before the move — and from that moment the booking behaves like any
 * other for email/money automation.
 *
 * Two things deliberately do NOT change with the toggle:
 *  - Crew paperwork surfaces (contract-signature nags on the schedule, board,
 *    crew sheets, documents, dashboard tile) stay keyed on source='imve':
 *    legacy customers signed the old system's paperwork, and a phone call
 *    doesn't create a Marley contract for the crew to collect.
 *  - No commitment invoice is invented retroactively: ensureCommitmentInvoice
 *    only fires from the date-confirmation flow, which imported (already
 *    date-confirmed) bookings never traverse.
 */
export interface LegacyLockFields {
  source: string | null;
  standard_comms_at: string | null;
}

/** True while automated customer email/money machinery must skip this quote. */
export const legacyLocked = (q: LegacyLockFields): boolean =>
  q.source === "imve" && !q.standard_comms_at;
