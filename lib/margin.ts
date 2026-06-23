import type { VehicleKey } from "@/lib/quote/constants";
import type { BusinessSettings } from "@/lib/settings";

/**
 * Job costing + margin — the single source for "what a job costs us", used by both
 * the Settings margin calculator (sandbox) and real confirmed jobs (Performance).
 * Crew is fixed by the van config; labour is a day rate per man.
 */

const CREW_BY_VEHICLE: Record<VehicleKey, number> = { "1luton": 2, "2luton": 3, "3luton": 4 };

/** 1 Luton=2, 2=3, 3=4, +1 for the 7.5t. */
export function crewSize(vehicle: VehicleKey, has75T: boolean): number {
  return (CREW_BY_VEHICLE[vehicle] ?? 2) + (has75T ? 1 : 0);
}

export interface JobCostInputs {
  vehicle: VehicleKey;
  has75T: boolean;
  vanCount: number;
  totalMiles: number;
  boxes: number;
  days: number;
}

export interface JobCost {
  labour: number;
  vans: number;
  fuel: number;
  boxes: number;
  misc: number;
  estimatorFee: number;
  total: number;
}

/** Per-job cost from the rate card. Labour = crew × days × day-rate; vans/fuel/boxes
 *  scale with the job; misc + the estimator (survey) fee are flat per job. */
export function jobCost(i: JobCostInputs, s: BusinessSettings): JobCost {
  const crew = crewSize(i.vehicle, i.has75T);
  const labour = crew * i.days * s.costLabourPerDay;
  const vans = i.vanCount * i.days * s.costVanDay;
  const fuel = i.totalMiles * s.costFuelPerMile;
  const boxes = i.boxes * s.costBox;
  const misc = s.costMisc;
  const estimatorFee = s.estimatorFee;
  return { labour, vans, fuel, boxes, misc, estimatorFee, total: labour + vans + fuel + boxes + misc + estimatorFee };
}

export function marginPct(revenue: number, cost: number): number {
  return revenue > 0 ? Math.round(((revenue - cost) / revenue) * 100) : 0;
}

/** Boxes supplied (the chargeable/cost-bearing box items) from wizard item state. */
export function boxesFromItems(items: Record<string, number> | null | undefined): number {
  if (!items) return 0;
  return (Number(items.wardrobeBoxes) || 0) + (Number(items.boxesBefore) || 0) + (Number(items.boxesOnCollection) || 0);
}
