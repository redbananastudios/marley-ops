/**
 * Vehicle compliance helpers — the improvement over iMVE, which stores tax/MOT/
 * insurance dates but never surfaces urgency. A document is "due" inside the
 * 30-day warning window and "overdue" past its date; the fleet page shows the
 * chips and the dashboard needs-action counts vehicles with any non-ok doc.
 */

export const VEHICLE_TYPES = [
  { value: "luton", label: "Luton van" },
  { value: "transit", label: "Transit van" },
  { value: "7.5t", label: "7.5t lorry" },
  { value: "other", label: "Other" },
] as const;

export type VehicleType = (typeof VEHICLE_TYPES)[number]["value"];

export const VEHICLE_DOCS = [
  { key: "tax_due", label: "Tax" },
  { key: "mot_due", label: "MOT" },
  { key: "insurance_renewal", label: "Insurance" },
] as const;

export type VehicleDocKey = (typeof VEHICLE_DOCS)[number]["key"];

export interface DocStatus {
  state: "none" | "ok" | "due" | "overdue";
  /** Whole days until the date (negative = overdue by that many). Null when unset. */
  days: number | null;
}

const DAY = 86_400_000;
export const DOC_WARN_DAYS = 30;

/** Status of one compliance date, evaluated against a UK calendar day. */
export function docStatus(date: string | null | undefined, today = new Date()): DocStatus {
  if (!date) return { state: "none", days: null };
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  if (isNaN(d.getTime())) return { state: "none", days: null };
  const todayStr = today.toLocaleDateString("en-CA", { timeZone: "Europe/London" });
  const t = new Date(`${todayStr}T00:00:00Z`);
  const days = Math.round((d.getTime() - t.getTime()) / DAY);
  if (days < 0) return { state: "overdue", days };
  if (days <= DOC_WARN_DAYS) return { state: "due", days };
  return { state: "ok", days };
}

export interface VehicleDocDates {
  tax_due: string | null;
  mot_due: string | null;
  insurance_renewal: string | null;
}

/** True when any compliance doc is due within the window or overdue. */
export function vehicleNeedsAttention(v: VehicleDocDates, today = new Date()): boolean {
  return VEHICLE_DOCS.some((d) => {
    const s = docStatus(v[d.key], today);
    return s.state === "due" || s.state === "overdue";
  });
}

/**
 * The full set of expiry dates the fleet-reminder engine tracks — a superset of
 * VEHICLE_DOCS that adds Service (routine) and Lease end. `autoOffRoad` marks the
 * ones that make a van legally un-driveable when overdue (MOT / Tax / Insurance):
 * those drop it from Job Board capacity. Service + Lease are reminder-only. The
 * list is the single source both the reminder cron and the off-road check read,
 * so adding tacho/tail-lift later (if a 7.5t ever joins) is a one-line change.
 */
export const VEHICLE_EXPIRIES = [
  { key: "tax_due", label: "Tax", autoOffRoad: true },
  { key: "mot_due", label: "MOT", autoOffRoad: true },
  { key: "insurance_renewal", label: "Insurance", autoOffRoad: true },
  { key: "service_due", label: "Service", autoOffRoad: false },
  { key: "end_of_term", label: "Lease end", autoOffRoad: false },
] as const;

export type VehicleExpiryKey = (typeof VEHICLE_EXPIRIES)[number]["key"];

/** The five expiry dates on a vehicle row that the fleet engine reads. */
export interface VehicleExpiryDates {
  tax_due: string | null;
  mot_due: string | null;
  insurance_renewal: string | null;
  service_due: string | null;
  end_of_term: string | null;
}

/** True when ANY tracked expiry (incl. Service + Lease) is due within the window
 *  or overdue — the full reminder scope, used by the dashboard needs-action card.
 *  (vehicleNeedsAttention stays the legal-3 amber flag for the Job Board.) */
export function vehicleHasExpiryDue(v: VehicleExpiryDates, today = new Date()): boolean {
  return VEHICLE_EXPIRIES.some((e) => {
    const s = docStatus(v[e.key], today);
    return s.state === "due" || s.state === "overdue";
  });
}
