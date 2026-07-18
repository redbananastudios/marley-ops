/**
 * Staff availability (pure) — the Job Board reads this to drop an unavailable
 * crew member from a day's free capacity, mirroring vehicleOffRoad for vans.
 *
 * The model (Peter, 2026-07-18): each crew member has a weekly WORKING PATTERN
 * (`working_days`, ISO weekday numbers 1=Mon … 7=Sun). Some are retained Mon–Fri,
 * some casual (fewer days), some regular weekend workers. That pattern is the
 * per-day DEFAULT: a day in the pattern is available, a day outside it is off.
 * A `staff_availability` row overrides ONE date on top of the pattern
 * ('available' offers a non-pattern day, 'unavailable' books a pattern day off).
 * When no pattern is passed the default is Mon–Fri — backwards-compatible with
 * the original 0053 behaviour. No DB here: the caller passes the UK calendar day.
 */

export const DEFAULT_WORKING_DAYS = [1, 2, 3, 4, 5] as const;

export interface AvailabilityRow {
  date: string; // YYYY-MM-DD
  status: "available" | "unavailable";
  note?: string | null;
}

export type EffectiveStatus = "available" | "unavailable";

const WD_SHORT = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** ISO weekday for a UK calendar day: 1=Mon … 7=Sun. Noon-UTC anchors the
 *  weekday to this exact day in GMT or BST without crossing a midnight edge. */
export function isoWeekday(ukDay: string): number {
  const dow = new Date(`${ukDay.slice(0, 10)}T12:00:00Z`).getUTCDay(); // 0 Sun … 6 Sat
  return dow === 0 ? 7 : dow;
}

/** Is `ukDay` a normal working day for this weekly pattern? Defaults to Mon–Fri
 *  when no pattern is supplied. */
export function defaultWorkingDay(ukDay: string, workingDays: readonly number[] = DEFAULT_WORKING_DAYS): boolean {
  return workingDays.includes(isoWeekday(ukDay));
}

/** True when the date is a Saturday or Sunday (UK calendar) — independent of any
 *  staff pattern; used purely for weekend styling/labels. */
export function isWeekend(ukDay: string): boolean {
  const d = isoWeekday(ukDay);
  return d === 6 || d === 7;
}

/** The effective status of one crew member on one day: an explicit row wins,
 *  otherwise the pattern default. */
export function effectiveStatus(
  rows: AvailabilityRow[],
  ukDay: string,
  workingDays: readonly number[] = DEFAULT_WORKING_DAYS,
): EffectiveStatus {
  const day = ukDay.slice(0, 10);
  const row = rows.find((r) => r.date.slice(0, 10) === day);
  if (row) return row.status;
  return defaultWorkingDay(day, workingDays) ? "available" : "unavailable";
}

export interface StaffOff {
  off: boolean;
  reason: string | null;
}

/** Is a crew member OFF on `ukDay`? Feeds the Job Board capacity strip + assign
 *  warning. Reason is the row's note when set, else why they're off by default:
 *  "Weekend" for Sat/Sun, "Rest day" for a weekday outside their pattern. */
export function staffOffOn(
  rows: AvailabilityRow[],
  ukDay: string,
  workingDays: readonly number[] = DEFAULT_WORKING_DAYS,
): StaffOff {
  const day = ukDay.slice(0, 10);
  const row = rows.find((r) => r.date.slice(0, 10) === day);
  if (row) {
    if (row.status === "unavailable") return { off: true, reason: row.note?.trim() || "Off" };
    return { off: false, reason: null }; // explicitly offered
  }
  if (defaultWorkingDay(day, workingDays)) return { off: false, reason: null };
  return { off: true, reason: isWeekend(day) ? "Weekend" : "Rest day" };
}

/** Clean a raw working-days array for storage/comparison: unique, valid 1–7,
 *  ascending. An empty result is legitimate (a fully-casual worker). */
export function normalizeWorkingDays(arr: readonly number[]): number[] {
  return [...new Set(arr)].filter((n) => Number.isInteger(n) && n >= 1 && n <= 7).sort((a, b) => a - b);
}

/** Human label for a weekly pattern: "Mon–Fri", "Mon, Tue", "Every day",
 *  "No set days". Used on staff cards, the wall chart and the crew portal. */
export function patternLabel(workingDays: readonly number[]): string {
  const s = normalizeWorkingDays(workingDays);
  if (s.length === 0) return "No set days";
  if (s.length === 7) return "Every day";
  const contiguous = s.every((n, i) => i === 0 || n === s[i - 1] + 1);
  if (contiguous && s.length >= 3) return `${WD_SHORT[s[0]]}–${WD_SHORT[s[s.length - 1]]}`;
  return s.map((n) => WD_SHORT[n]).join(", ");
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
