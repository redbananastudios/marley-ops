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

function addDay(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export interface AvailabilitySegment {
  start: string;
  end: string;
  status: "available" | "unavailable";
  note: string | null;
  ids: string[];
}

/** Collapse per-date availability rows into contiguous runs of the same status
 *  and note, so a week's holiday reads as one "21–25 Jul" line in the office
 *  view (and deletes as one). Dates are unique per staff (DB constraint). */
export function groupAvailabilityRuns(
  rows: { id: string; date: string; status: string; note: string | null }[],
): AvailabilitySegment[] {
  const sorted = [...rows].sort((a, b) => a.date.slice(0, 10).localeCompare(b.date.slice(0, 10)));
  const segments: AvailabilitySegment[] = [];
  for (const r of sorted) {
    const date = r.date.slice(0, 10);
    const status: "available" | "unavailable" = r.status === "available" ? "available" : "unavailable";
    const note = r.note ?? null;
    const last = segments[segments.length - 1];
    if (last && last.status === status && (last.note ?? null) === note && addDay(last.end) === date) {
      last.end = date;
      last.ids.push(r.id);
    } else {
      segments.push({ start: date, end: date, status, note, ids: [r.id] });
    }
  }
  return segments;
}
