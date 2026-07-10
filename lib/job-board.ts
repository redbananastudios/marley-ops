/**
 * Job Board helpers — day spans, resource availability and clash detection for
 * the week board (iMVE clone-and-improve, docs/imve-discovery.md §1).
 *
 * Availability semantics per UK calendar day:
 *  - free    = no assignment touching the day
 *  - partial = only TIMED appointments (part of the day is still open)
 *  - booked  = an all-day appointment (a removal) owns the day
 * Clashes warn, never block — a van genuinely can do two half-day jobs.
 */

import { VAN_COUNT, type VehicleKey } from "@/lib/quote/constants";
import { crewSize } from "@/lib/margin";

export interface ApptLite {
  id: string;
  starts_at: string | null;
  ends_at: string | null;
  all_day: boolean | null;
}

const UK = "Europe/London";
const DAY = 86_400_000;
/** Fallback duration for open-ended timed appointments (surveys default ~1h; use 2h to be safe). */
const DEFAULT_MS = 2 * 3_600_000;

const ukDay = (ms: number): string => new Date(ms).toLocaleDateString("en-CA", { timeZone: UK });

/** UK calendar days an appointment touches, in order. */
export function apptDays(a: ApptLite): string[] {
  if (!a.starts_at) return [];
  const start = new Date(a.starts_at).getTime();
  if (Number.isNaN(start)) return [];
  const rawEnd = a.ends_at ? new Date(a.ends_at).getTime() : start + (a.all_day ? 0 : DEFAULT_MS);
  const end = Math.max(start, Number.isNaN(rawEnd) ? start : rawEnd);
  const days: string[] = [ukDay(start)];
  for (let t = start + DAY; t < end; t += DAY) {
    const d = ukDay(t);
    if (days[days.length - 1] !== d) days.push(d);
  }
  // The end day counts unless the appt ends exactly at midnight — 00:00 is a
  // boundary, not time spent on that day.
  const endDay = ukDay(end);
  if (end > start && endDay !== days[days.length - 1] && ukHm(end) !== "00:00") days.push(endDay);
  return days;
}

const ukHm = (ms: number): string =>
  new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: UK });

/** "09:00–13:30" (or "All day") for card + popover display. */
export function apptWindow(a: ApptLite): string {
  if (a.all_day || !a.starts_at) return "All day";
  const s = new Date(a.starts_at).getTime();
  const e = a.ends_at ? new Date(a.ends_at).getTime() : null;
  return e && e > s ? `${ukHm(s)}–${ukHm(e)}` : ukHm(s);
}

/** Do two appointments clash? All-day appts clash with anything sharing a day;
 *  two timed appts clash only when their actual intervals overlap. */
export function apptsClash(a: ApptLite, b: ApptLite): boolean {
  if (!a.starts_at || !b.starts_at) return false;
  if (a.all_day || b.all_day) {
    const days = new Set(apptDays(a));
    return apptDays(b).some((d) => days.has(d));
  }
  const aS = new Date(a.starts_at).getTime();
  const aE = a.ends_at ? new Date(a.ends_at).getTime() : aS + DEFAULT_MS;
  const bS = new Date(b.starts_at).getTime();
  const bE = b.ends_at ? new Date(b.ends_at).getTime() : bS + DEFAULT_MS;
  return aS < bE && bS < aE;
}

export interface AssignmentLite {
  appointment_id: string;
  staff_id: string | null;
  vehicle_id: string | null;
}

export type DayState = "free" | "partial" | "booked";

/** One resource's state on one day, given the appointments it's assigned to. */
export function resourceDayState(day: string, assignedAppts: ApptLite[]): DayState {
  let state: DayState = "free";
  for (const a of assignedAppts) {
    if (!apptDays(a).includes(day)) continue;
    if (a.all_day) return "booked";
    state = "partial";
  }
  return state;
}

/** The appointments a resource is assigned to (non-cancelled ones should be passed in). */
export function apptsForResource(
  resourceId: string,
  kind: "staff" | "vehicle",
  assignments: AssignmentLite[],
  apptById: Map<string, ApptLite>,
): ApptLite[] {
  const key = kind === "staff" ? "staff_id" : "vehicle_id";
  const out: ApptLite[] = [];
  for (const as of assignments) {
    if (as[key] !== resourceId) continue;
    const a = apptById.get(as.appointment_id);
    if (a) out.push(a);
  }
  return out;
}

/** Assigned appointments of a resource that clash with the target appointment
 *  (the target itself excluded) — feeds the warn-don't-block UI. */
export function clashesFor(
  resourceId: string,
  kind: "staff" | "vehicle",
  target: ApptLite,
  assignments: AssignmentLite[],
  apptById: Map<string, ApptLite>,
): ApptLite[] {
  return apptsForResource(resourceId, kind, assignments, apptById).filter(
    (a) => a.id !== target.id && apptsClash(a, target),
  );
}

/** Vans + men a job needs, derived from the accepted quote's shape — the loop
 *  iMVE never closes (they hold a free-text "resources required" box instead). */
export function crewRequired(
  breakdown: { vehicle?: string; sevenFiveT?: number; has75T?: boolean; transitVans?: number } | null | undefined,
): { vans: number; men: number } | null {
  if (!breakdown?.vehicle) return null;
  const vehicle = breakdown.vehicle as VehicleKey;
  if (!(vehicle in VAN_COUNT)) return null;
  const sevenFiveT = breakdown.sevenFiveT ?? (breakdown.has75T ? 1 : 0);
  const transitVans = breakdown.transitVans ?? 0;
  const vans = (VAN_COUNT[vehicle] ?? 1) + sevenFiveT + transitVans;
  const men = crewSize(vehicle, sevenFiveT, false, transitVans);
  return { vans, men };
}
