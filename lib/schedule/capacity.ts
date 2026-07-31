/**
 * Schedule & Allocation — capacity grading (pure, framework-free).
 *
 * Two questions, two denominators (design doc §D5):
 *   - Availability ("can we sell this day?") grades on the REQUIRED vans/crew of the
 *     day's CONFIRMED jobs vs the live fleet. A confirmed job commits the fleet whether
 *     or not it has been crewed yet, so sellability uses `required`, never `assigned`.
 *   - Day Allocation ("is it ready to run?") is a dispatch concern and works off assigned
 *     vs required per job — it does not live here.
 *
 * The four states are DERIVED from the fleet, not painted — and the "limited" line is a
 * threshold (config), so the office can dial where amber starts without a code change.
 */

import { staffOffOn, type AvailabilityRow } from "@/lib/staff/availability";
import { vehicleOffRoad, type UnavailabilityWindow } from "@/lib/fleet/availability";
import type { VehicleExpiryDates } from "@/lib/vehicles";

export type CapacityState = "available" | "limited" | "full" | "over";

export interface Fleet {
  vans: number;
  crew: number;
}

/** Staff shape the per-day fleet needs: identity + weekly working pattern. */
export interface FleetStaff {
  id: string;
  working_days: number[] | null;
}

/** Vehicle shape the per-day fleet needs: identity + the five expiry dates. */
export type FleetVehicle = VehicleExpiryDates & { id: string };

/**
 * The fleet ACTUALLY usable on one UK calendar day — the SAME off-road / not-working
 * rules the Job Board's capacity strip applies (staffOffOn + vehicleOffRoad), so the
 * Availability calendar grades a day against the crew and vans that can genuinely turn
 * up, not a constant all-time headcount. A weekend on which nobody works yields
 * { vans, crew: 0 }, so Availability and Day Allocation agree instead of the calendar
 * claiming full crew where the Job Board correctly shows 0.
 */
export function usableFleetForDay(input: {
  day: string;
  staff: FleetStaff[];
  vehicles: FleetVehicle[];
  availByStaff: Map<string, AvailabilityRow[]>;
  unavailByVehicle: Map<string, UnavailabilityWindow[]>;
}): Fleet {
  const crew = input.staff.filter(
    (s) => !staffOffOn(input.availByStaff.get(s.id) ?? [], input.day, s.working_days ?? undefined).off,
  ).length;
  const vans = input.vehicles.filter(
    (v) => !vehicleOffRoad(v, input.unavailByVehicle.get(v.id) ?? [], input.day).offRoad,
  ).length;
  return { vans, crew };
}

export interface CapacityThresholds {
  /**
   * A resource axis flips to "limited" when its free count falls to <= this value.
   * Default 1 = "down to your last van / crew". Raise it for a bigger fleet so a day
   * only reads amber when it is genuinely tight.
   */
  limitedAt: number;
}

export const DEFAULT_THRESHOLDS: CapacityThresholds = { limitedAt: 1 };

const RANK: Record<CapacityState, number> = { available: 0, limited: 1, full: 2, over: 3 };

/** Grade one resource axis (vans OR crew) from how many are free. */
function axisState(free: number, t: CapacityThresholds): CapacityState {
  if (free < 0) return "over"; // committed needs exceed the fleet — hire in / move a flexible job
  if (free === 0) return "full"; // none spare
  if (free <= t.limitedAt) return "limited"; // down to the last of this resource
  return "available";
}

export interface DayCapacity {
  state: CapacityState;
  freeVans: number;
  freeCrew: number;
}

/**
 * Grade a day for SELLABILITY. Worst of the two axes wins — a day with a spare van but
 * no crew is still un-sellable, so it reads by its tightest resource.
 */
export function dayCapacityState(input: {
  requiredVans: number;
  requiredCrew: number;
  fleet: Fleet;
  thresholds?: CapacityThresholds;
}): DayCapacity {
  const t = input.thresholds ?? DEFAULT_THRESHOLDS;
  const freeVans = input.fleet.vans - input.requiredVans;
  const freeCrew = input.fleet.crew - input.requiredCrew;
  const v = axisState(freeVans, t);
  const c = axisState(freeCrew, t);
  return { state: RANK[v] >= RANK[c] ? v : c, freeVans, freeCrew };
}

export interface JobRequirement {
  requiredVans: number;
  requiredCrew: number;
}

/**
 * A booked removal always commits at least this much fleet. When its lead has no
 * priceable quote (or it's a manual, lead-less diary block) we can't derive the real
 * vans/crew — but a real move can't run on nothing, so grading its day as needing ZERO
 * would overstate sellable capacity and let a second move be sold onto a committed day.
 * Floor it at one van + a two-person crew (the smallest crew that can run a move).
 */
export const MIN_BOOKED_REQUIREMENT: JobRequirement = { requiredVans: 1, requiredCrew: 2 };

/**
 * Sum the required vans/crew across a day's confirmed jobs. Crew-only pack jobs
 * (requiredVans 0) fold in naturally — a pack day still consumes crew.
 */
export function sumRequired(jobs: JobRequirement[]): { requiredVans: number; requiredCrew: number } {
  return jobs.reduce(
    (acc, j) => ({
      requiredVans: acc.requiredVans + j.requiredVans,
      requiredCrew: acc.requiredCrew + j.requiredCrew,
    }),
    { requiredVans: 0, requiredCrew: 0 },
  );
}

/**
 * Warn-only driver check (design doc §D12): a job with a van assigned needs at least one
 * driver among its assigned crew, or the van cannot leave. This never blocks a save — it
 * mirrors the existing clash warnings; the office decides.
 */
export function needsDriverWarning(input: { assignedVans: number; assignedDrivers: number }): boolean {
  return input.assignedVans > 0 && input.assignedDrivers === 0;
}
