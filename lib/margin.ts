import { VAN_COUNT, type VehicleKey } from "@/lib/quote/constants";
import type { BusinessSettings } from "@/lib/settings";

/**
 * Job costing + margin — the single source for "what a job costs us", used by both
 * the Settings margin calculator (sandbox) and real confirmed jobs (Performance).
 *
 * Crew is fixed by the van config (1 Luton=2, 2=3, 3=4, +1 for the 7.5t). Each vehicle
 * brings 1 man (its driver), covered by that vehicle's cost — so labour bills only the
 * EXTRA crew beyond one-per-vehicle (a single helper in every standard config). The
 * 7.5t lorry is a flat per-job cost that already includes its man.
 */

const CREW_BY_VEHICLE: Record<VehicleKey, number> = {
  "1luton": 2,
  "2luton": 3,
  "3luton": 4,
  "4luton": 5,
  "5luton": 6,
};

export function crewSize(vehicle: VehicleKey, sevenFiveT: number): number {
  return (CREW_BY_VEHICLE[vehicle] ?? 2) + sevenFiveT;
}

/** Vehicles on the job (Lutons + the 7.5t lorries). Each provides one included man. */
export function vehicleCount(vehicle: VehicleKey, sevenFiveT: number): number {
  return (VAN_COUNT[vehicle] ?? 1) + sevenFiveT;
}

/** Crew billed at the day rate = total crew minus the one included man per vehicle. */
export function extraCrew(vehicle: VehicleKey, sevenFiveT: number): number {
  return Math.max(0, crewSize(vehicle, sevenFiveT) - vehicleCount(vehicle, sevenFiveT));
}

export interface JobCostInputs {
  vehicle: VehicleKey;
  /** Number of 7.5t lorries on the job (cost = N × cost75t). */
  sevenFiveT: number;
  totalMiles: number;
  boxes: number;
  days: number;
}

export interface JobCost {
  labour: number;
  vans: number;
  sevenT: number;
  fuel: number;
  boxes: number;
  misc: number;
  estimatorFee: number;
  total: number;
}

/** Per-job cost from the rate card. Labour = extra crew × days × day-rate; Luton vans
 *  scale with days; the 7.5t is a flat per-job cost (incl. its man); fuel/boxes scale
 *  with the job; misc + the estimator (survey) fee are flat per job. */
export function jobCost(i: JobCostInputs, s: BusinessSettings): JobCost {
  const lutonVans = VAN_COUNT[i.vehicle] ?? 1;
  const labour = extraCrew(i.vehicle, i.sevenFiveT) * i.days * s.costLabourPerDay;
  const vans = lutonVans * i.days * s.costVanDay;
  const sevenT = i.sevenFiveT * s.cost75t;
  const fuel = i.totalMiles * s.costFuelPerMile;
  const boxes = i.boxes * s.costBox;
  const misc = s.costMisc;
  const estimatorFee = s.estimatorFee;
  return {
    labour,
    vans,
    sevenT,
    fuel,
    boxes,
    misc,
    estimatorFee,
    total: labour + vans + sevenT + fuel + boxes + misc + estimatorFee,
  };
}

export function marginPct(revenue: number, cost: number): number {
  return revenue > 0 ? Math.round(((revenue - cost) / revenue) * 100) : 0;
}

/** Boxes supplied (the chargeable/cost-bearing box items) from wizard item state. */
export function boxesFromItems(items: Record<string, number> | null | undefined): number {
  if (!items) return 0;
  return (Number(items.wardrobeBoxes) || 0) + (Number(items.boxesBefore) || 0) + (Number(items.boxesOnCollection) || 0);
}
