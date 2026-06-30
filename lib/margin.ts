import { VAN_COUNT, type VehicleKey } from "@/lib/quote/constants";
import type { BusinessSettings } from "@/lib/settings";

/**
 * Job costing + margin — the single source for "what a job costs us", used by both
 * the Settings margin calculator (sandbox) and real confirmed jobs (Performance).
 *
 * Crew (men) is fixed by the job shape: a Luton config carries vans + 1 (1 Luton = 2
 * men, 2 = 3, … 5 = 6). Each 7.5t lorry carries 1 man by default, or 2 with the
 * second-man option. Labour bills EVERY man at the day rate; the van/lorry costs are
 * the vehicles only.
 */

const LUTON_CREW: Record<VehicleKey, number> = {
  "1luton": 2,
  "2luton": 3,
  "3luton": 4,
  "4luton": 5,
  "5luton": 6,
};

/** Total men on the job: Lutons give vans + 1; each 7.5t gives 1 man (2 with the second-man option). */
export function crewSize(vehicle: VehicleKey, sevenFiveT: number, sevenFiveTSecondMan = false): number {
  const lorryCrew = sevenFiveT * (sevenFiveTSecondMan ? 2 : 1);
  return (LUTON_CREW[vehicle] ?? 2) + lorryCrew;
}

export interface JobCostInputs {
  vehicle: VehicleKey;
  /** Number of 7.5t lorries on the job (cost = N × cost75t). */
  sevenFiveT: number;
  /** Each 7.5t lorry carries a second man (so 2 men per lorry instead of 1). */
  sevenFiveTSecondMan?: boolean;
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

/** Per-job cost from the rate card. Labour = full crew × days × day-rate; Luton vans
 *  scale with days; each 7.5t is a flat per-lorry vehicle cost; fuel/boxes scale with
 *  the job; misc + the estimator (survey) fee are flat per job. */
export function jobCost(i: JobCostInputs, s: BusinessSettings): JobCost {
  const lutonVans = VAN_COUNT[i.vehicle] ?? 1;
  const crew = crewSize(i.vehicle, i.sevenFiveT, i.sevenFiveTSecondMan);
  const labour = crew * i.days * s.costLabourPerDay;
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
