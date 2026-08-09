/**
 * Was this survey visit attended?
 *
 * Peter's rule (2026-08-09): "we can assume that if the appointment has not
 * been deleted on the schedule it has been attended."
 *
 * DERIVED, never stored. Two reasons that matter:
 *  - A deleted appointment is simply absent, so "not deleted" needs no column;
 *    the row's continued existence IS the evidence.
 *  - The estimator arrangement is changing, so writing attendance facts into
 *    the database now would bake in a rule we may have to unwind. A derivation
 *    is one function to change instead of a backfill to undo.
 *
 * Two conditions the bare rule leaves implicit:
 *  - CANCELLED does not count. Cancelling a survey emails the customer "please
 *    don't wait in", so it is an explicit statement that nobody went. Counting
 *    it would inflate visit counts and drag win rate down with visits that
 *    never happened.
 *  - The slot must have PASSED. A survey booked for next Friday has not been
 *    attended yet, and counting it would make win rate meaningless (a visit
 *    that has not happened cannot have won).
 *
 * Deliberately NOT used by the estimator pay/invoice engine, which still keys
 * off `status='completed'`. Peter, 2026-08-09: ignore per-appointment payment
 * for now, it may change. This governs STATS only.
 */

export interface AttendableAppointment {
  status?: string | null;
  starts_at?: string | null;
  ends_at?: string | null;
}

/**
 * True once the visit is over and the appointment is still standing.
 * Uses the END of the slot so a visit in progress is not counted early;
 * falls back to the start when no end is recorded.
 */
export function isAttendedSurvey(appt: AttendableAppointment, now: Date = new Date()): boolean {
  if (appt.status === "cancelled") return false;
  const finishedAt = Date.parse(appt.ends_at ?? appt.starts_at ?? "");
  if (!Number.isFinite(finishedAt)) return false;
  return finishedAt <= now.getTime();
}

/** Filter a set of survey appointments down to the attended ones. */
export function attendedSurveys<T extends AttendableAppointment>(rows: readonly T[], now: Date = new Date()): T[] {
  return rows.filter((r) => isAttendedSurvey(r, now));
}

/**
 * The coarse SQL-side pre-filter that pairs with the predicate above: everything
 * still on the schedule. The past-check stays in JS because `ends_at` is
 * nullable and PostgREST cannot express the coalesce cleanly.
 *
 * Exported as a named constant so the call sites read as a deliberate choice
 * rather than a stray string, and so a future status value has one place to
 * be considered.
 */
export const NOT_CANCELLED = "cancelled";
