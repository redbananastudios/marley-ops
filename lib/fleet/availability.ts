/**
 * Vehicle off-road logic (pure) — the Job Board reads this to drop an unusable van
 * from the day's free capacity. A van is off the road on a UK calendar day when:
 *   - an unavailability window (garage / repair) covers that day, OR
 *   - a legal expiry (MOT / Tax / Insurance) is overdue as of that day.
 * Service + Lease do NOT off-road a van (you can still drive it) — they only remind.
 * Windows win the reason label. No DB, no dates-from-now: the caller passes the day.
 */

import { docStatus, VEHICLE_EXPIRIES, type VehicleExpiryDates } from "@/lib/vehicles";

export interface UnavailabilityWindow {
  start_date: string; // YYYY-MM-DD (inclusive)
  end_date: string; // YYYY-MM-DD (inclusive)
  reason: string; // service | mot | repair | other
}

const REASON_LABEL: Record<string, string> = {
  service: "Service booked",
  mot: "MOT booked",
  repair: "In for repair",
  other: "Off-road",
};

export interface OffRoad {
  offRoad: boolean;
  reason: string | null;
}

/** Is a van off the road on `ukDay` (YYYY-MM-DD)? Window match wins the label. */
export function vehicleOffRoad(
  expiries: VehicleExpiryDates,
  windows: UnavailabilityWindow[],
  ukDay: string,
): OffRoad {
  const day = ukDay.slice(0, 10);
  for (const w of windows) {
    if (day >= w.start_date.slice(0, 10) && day <= w.end_date.slice(0, 10)) {
      return { offRoad: true, reason: REASON_LABEL[w.reason] ?? "Off-road" };
    }
  }
  // Noon-UTC anchors the docStatus "today" to this exact calendar day in either
  // GMT or BST without crossing a midnight boundary.
  const asOf = new Date(`${day}T12:00:00Z`);
  for (const e of VEHICLE_EXPIRIES) {
    if (!e.autoOffRoad) continue;
    if (docStatus(expiries[e.key], asOf).state === "overdue") {
      return { offRoad: true, reason: `${e.label} overdue` };
    }
  }
  return { offRoad: false, reason: null };
}
