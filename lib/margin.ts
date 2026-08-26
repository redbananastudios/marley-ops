import { VAN_COUNT, type VehicleKey } from "@/lib/quote/constants";
import type { BusinessSettings } from "@/lib/settings";

/**
 * Job costing + margin — the single source for "what a job costs us", used by both
 * the Settings margin calculator (sandbox) and real confirmed jobs (Performance).
 *
 * Crew (men) is fixed by the job shape: a Luton config carries vans + 1 (1 Luton = 2
 * men, 2 = 3, … 5 = 6); a Transit tier carries 1 man. Each 7.5t lorry carries 1 man
 * by default (2 with the second-man option); each add-on Transit carries 1 man.
 * Labour bills EVERY man at the day rate; the vehicle costs are vehicles only.
 */

const TIER_CREW: Record<VehicleKey, number> = {
  transit: 1,
  "1luton": 2,
  "2luton": 3,
  "3luton": 4,
  "4luton": 5,
  "5luton": 6,
};

/** Total men on the job: base tier crew + 7.5t crew + 1 per add-on Transit. */
export function crewSize(
  vehicle: VehicleKey,
  sevenFiveT: number,
  sevenFiveTSecondMan = false,
  transitVans = 0,
): number {
  const lorryCrew = sevenFiveT * (sevenFiveTSecondMan ? 2 : 1);
  return (TIER_CREW[vehicle] ?? 2) + lorryCrew + transitVans;
}

export interface JobCostInputs {
  vehicle: VehicleKey;
  /** Number of 7.5t lorries on the job (cost = N × cost75t). */
  sevenFiveT: number;
  /** Each 7.5t lorry carries a second man (so 2 men per lorry instead of 1). */
  sevenFiveTSecondMan?: boolean;
  /** Add-on Transit vans on top of the base tier (1 man each). */
  transitVans?: number;
  totalMiles: number;
  boxes: number;
  days: number;
}

export interface JobCost {
  labour: number;
  vans: number;
  /** Transit vehicle cost (tier transit + add-on transits) × day rate × days. */
  transits: number;
  sevenT: number;
  /** Luton + Transit fuel = miles × Luton fuel rate × number of vans. */
  fuel: number;
  /** 7.5t fuel = miles × 7.5t fuel rate × number of lorries. */
  fuel75: number;
  boxes: number;
  misc: number;
  estimatorFee: number;
  total: number;
}

/** Vehicle counts by kind for a job shape. A transit TIER is 1 transit, 0 Lutons. */
function vehicleMix(vehicle: VehicleKey, transitVans: number): { lutons: number; transits: number } {
  if (vehicle === "transit") return { lutons: 0, transits: 1 + transitVans };
  return { lutons: VAN_COUNT[vehicle] ?? 1, transits: transitVans };
}

/** Per-job cost from the rate card. Labour = full crew × days × day-rate; Lutons and
 *  Transits scale with days at their own day rates; each 7.5t is a flat per-lorry
 *  vehicle cost; fuel scales with miles AND vehicle count (Transits burn at the Luton
 *  rate for now); boxes scale with the job; misc + the estimator fee are flat. */
export function jobCost(i: JobCostInputs, s: BusinessSettings): JobCost {
  const transitCount = i.transitVans ?? 0;
  const { lutons, transits } = vehicleMix(i.vehicle, transitCount);
  const crew = crewSize(i.vehicle, i.sevenFiveT, i.sevenFiveTSecondMan, transitCount);
  const labour = crew * i.days * s.costLabourPerDay;
  const vans = lutons * i.days * s.costVanDay;
  const transitsCost = transits * i.days * s.costTransitDay;
  const sevenT = i.sevenFiveT * s.cost75t;
  const fuel = i.totalMiles * s.costFuelPerMile * (lutons + transits);
  const fuel75 = i.totalMiles * s.costFuel75PerMile * i.sevenFiveT;
  const boxes = i.boxes * s.costBox;
  const misc = s.costMisc;
  const estimatorFee = s.estimatorFee;
  return {
    labour,
    vans,
    transits: transitsCost,
    sevenT,
    fuel,
    fuel75,
    boxes,
    misc,
    estimatorFee,
    total: labour + vans + transitsCost + sevenT + fuel + fuel75 + boxes + misc + estimatorFee,
  };
}

export function marginPct(revenue: number, cost: number): number {
  return revenue > 0 ? Math.round(((revenue - cost) / revenue) * 100) : 0;
}

/**
 * Revenue to use for a job's MARGIN — the gross price the customer paid minus the
 * VAT the business actually hands to HMRC, so pass-through tax isn't read as profit.
 *
 * A quote's agreed_price / grand_total is the GROSS (VAT-inclusive when the quote
 * charged VAT). That gross already contains the internal additional-charges uplift
 * (PRD §3.9 — computeQuote prices it into the subtotal), so the uplift counts as
 * revenue here with NO separate term: adding one would double-count it. The
 * rate-card jobCost carries no VAT, so to compare like-for-like we
 * strip the VAT LIABILITY off revenue (mirrors lib/finance/invoices.ts `vatOwed`):
 *   - vatEnabled false → the price carried no VAT; nothing to strip → net = gross.
 *   - standard scheme  → owe the 20% charged             → net = gross / 1.2.
 *   - flat_rate (FRS)  → owe flatPct × VAT-inclusive gross → net = gross × (1 − flatPct/100).
 * Under the FRS the business keeps the VAT surplus (20% charged − flat % paid), so that
 * surplus is genuine margin and only the flat % owed to HMRC is removed.
 */
export function marginRevenue(gross: number, vatEnabled: boolean, s: BusinessSettings): number {
  if (!(gross > 0)) return 0;
  if (!vatEnabled) return gross;
  if (s.vatScheme === "flat_rate") {
    const pct = Number.isFinite(s.vatFlatRatePct) ? Math.max(0, s.vatFlatRatePct) : 0;
    return gross * (1 - pct / 100);
  }
  return gross / 1.2;
}

/**
 * A lead's 3rd-party referral commission as a job cost. Some manually-added
 * leads carry a fee owed to whoever referred them — profit/margin surfaces
 * (dashboard KPI, Performance "Jobs & margin") add it to the rate-card job
 * cost so the margin shown is what the job REALLY makes. Defensive: absent,
 * garbled or negative values cost 0 (Postgres numerics arrive as strings).
 */
export function commissionCost(value: number | string | null | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Boxes supplied (the chargeable/cost-bearing box items) from wizard item state. */
export function boxesFromItems(items: Record<string, number> | null | undefined): number {
  if (!items) return 0;
  return (Number(items.wardrobeBoxes) || 0) + (Number(items.boxesBefore) || 0) + (Number(items.boxesOnCollection) || 0);
}
