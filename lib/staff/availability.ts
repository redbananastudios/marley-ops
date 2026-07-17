/**
 * Staff availability (pure) — the Job Board reads this to drop an unavailable
 * crew member from a day's free capacity, mirroring vehicleOffRoad for vans.
 *
 * The model (Peter, 2026-07-17): crew are self-employed and "usually Mon–Fri".
 * So the DEFAULT for a day with no explicit row is: weekday = available,
 * weekend = off. A `staff_availability` row overrides the default for that one
 * date — 'available' offers a weekend, 'unavailable' books a weekday off.
 * No DB, no dates-from-now: the caller passes the UK calendar day.
 */

export interface AvailabilityRow {
  date: string; // YYYY-MM-DD
  status: "available" | "unavailable";
  note?: string | null;
}

export type EffectiveStatus = "available" | "unavailable";

/** The default working assumption for a bare day: Mon–Fri yes, Sat/Sun no.
 *  Noon-UTC anchors the weekday to this exact calendar day in GMT or BST
 *  without crossing a midnight boundary. */
export function defaultWorkingDay(ukDay: string): boolean {
  const dow = new Date(`${ukDay.slice(0, 10)}T12:00:00Z`).getUTCDay(); // 0 Sun … 6 Sat
  return dow >= 1 && dow <= 5;
}

/** True when the date is a Saturday or Sunday (UK calendar). */
export function isWeekend(ukDay: string): boolean {
  const dow = new Date(`${ukDay.slice(0, 10)}T12:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6;
}

/** The effective status of one crew member on one day: an explicit row wins,
 *  otherwise the weekday/weekend default. */
export function effectiveStatus(rows: AvailabilityRow[], ukDay: string): EffectiveStatus {
  const day = ukDay.slice(0, 10);
  const row = rows.find((r) => r.date.slice(0, 10) === day);
  if (row) return row.status;
  return defaultWorkingDay(day) ? "available" : "unavailable";
}

export interface StaffOff {
  off: boolean;
  reason: string | null;
}

/** Is a crew member OFF on `ukDay`? Feeds the Job Board capacity strip + assign
 *  warning. Reason is the row's note when set, else why they're off by default. */
export function staffOffOn(rows: AvailabilityRow[], ukDay: string): StaffOff {
  const day = ukDay.slice(0, 10);
  const row = rows.find((r) => r.date.slice(0, 10) === day);
  if (row) {
    if (row.status === "unavailable") return { off: true, reason: row.note?.trim() || "Off" };
    return { off: false, reason: null }; // explicitly offered
  }
  return defaultWorkingDay(day) ? { off: false, reason: null } : { off: true, reason: "Weekend" };
}
