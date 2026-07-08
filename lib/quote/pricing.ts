/**
 * Quote pricing engine — pure, framework-free transcription of the live MM Quotes
 * `gatherQuoteData()` (quotes-app/public/index.html L2301-2342) + its two helpers
 * (`getAccessCharge` / `getFloorCharge`, L2288-2296).
 *
 * This is the ONLY place money is computed in Marley Ops. The wizard, the PDF, the
 * panel-edit screen and the tests all call computeQuote() so totals can never drift.
 *
 * Transcribed character-for-character: same operators, same order, same Math.max(0,…),
 * same `* 0.20`. Do NOT refactor the arithmetic — float reordering can shift a penny.
 * VAT is a single line at the very end: (subtotal incl. £150 admin fee − discount) × 20%.
 */

import {
  ADDON_75T_BASE,
  ADDON_75T_PACK,
  ADDON_TRANSIT_BASE,
  ADMIN_FEE,
  BASE_PRICES,
  CONGESTION_PER_VAN,
  EXTRA_DAY_RATE,
  FLOOR_PRICES,
  MILEAGE_RATE,
  PACK_PRICES,
  VAN_COUNT,
  type FloorKey,
  type PackingKey,
  type PropertyType,
  type VehicleKey,
} from './constants';

/**
 * Editable price levers. computeQuote defaults to DEFAULT_PRICING (the locked
 * constants) so the live engine + every test are unchanged; the margin calculator
 * passes an overridden config to model "what if I charged X". Access tiers (£100/£300)
 * and the 20% VAT rate stay fixed for now.
 */
export interface PricingConfig {
  base: Record<VehicleKey, number>;
  pack: Record<VehicleKey, Record<PackingKey, number>>;
  addon75Base: number;
  addon75Pack: Record<PackingKey, number>;
  /** Add-on Transit van: flat per van (its 1 man included). */
  addonTransitBase: number;
  floor: Record<FloorKey, number>;
  adminFee: number;
  mileageRate: number;
  congestionPerVan: number;
  /** Charge per day AFTER the first on multi-day jobs. */
  extraDayRate: number;
}

export const DEFAULT_PRICING: PricingConfig = {
  base: BASE_PRICES,
  pack: PACK_PRICES,
  addon75Base: ADDON_75T_BASE,
  addon75Pack: ADDON_75T_PACK,
  addonTransitBase: ADDON_TRANSIT_BASE,
  floor: FLOOR_PRICES,
  adminFee: ADMIN_FEE,
  mileageRate: MILEAGE_RATE,
  congestionPerVan: CONGESTION_PER_VAN,
  extraDayRate: EXTRA_DAY_RATE,
};

export interface QuoteInputs {
  vehicle: VehicleKey;
  packing: PackingKey;
  /** Legacy single 7.5t flag. Still read for back-compat; sevenFiveT takes precedence. */
  has75T?: boolean;
  /** Number of 7.5t lorries (0..MAX_75T). Each is a flat add-on + counts as a vehicle. */
  sevenFiveT?: number;
  /** Number of add-on Transit vans (0..MAX_TRANSIT). Flat per van + counts as a vehicle. */
  transitVans?: number;
  /** Days on the job (≥1). Each day after the first adds extraDayRate to the quote. */
  days?: number;
  /** Dead miles (base→collect + dest→base). null until the 3-leg route is calculated. */
  deadMiles: number | null;
  /** Job miles (collect→dest). null until calculated. */
  jobMiles: number | null;
  collectAccessM: number;
  destAccessM: number;
  collectType: PropertyType;
  collectFloor: FloorKey;
  destType: PropertyType;
  destFloor: FloorKey;
  congestion: boolean;
  tolls: number;
  parking: number;
  discount: number;
  vatEnabled: boolean;
}

export interface QuoteBreakdown {
  vehicle: VehicleKey;
  packing: PackingKey;
  has75T: boolean;
  /** Number of 7.5t lorries on the job (0..MAX_75T). */
  sevenFiveT: number;
  /** Number of add-on Transit vans on the job (0..MAX_TRANSIT). */
  transitVans: number;
  vanCount: number;
  base: number;
  packCost: number;
  addon75Cost: number;
  addon75PackCost: number;
  /** Add-on Transit vans cost (count × addonTransitBase). */
  transitCost: number;
  /** Days on the job (≥1). */
  days: number;
  /** (days − 1) × extraDayRate — additional-day charge on multi-day jobs. */
  extraDaysCost: number;
  mileageCost: number | null;
  totalMiles: number | null;
  collectAccessM: number;
  destAccessM: number;
  collectAccessCost: number;
  destAccessCost: number;
  collectType: PropertyType;
  collectFloor: FloorKey;
  destType: PropertyType;
  destFloor: FloorKey;
  collectFloorCost: number;
  destFloorCost: number;
  congestion: number;
  tolls: number;
  parking: number;
  discount: number;
  subtotal: number;
  total: number;
  vatEnabled: boolean;
  vatAmount: number;
  grandTotal: number;
  adminFee: number;
}

/** L2288-2292 verbatim. `!m` keeps 0/NaN at £0; 10–20m → £100; >20m → £300. */
export function getAccessCharge(m: number): number {
  if (!m || m < 10) return 0;
  if (m <= 20) return 100;
  return 300;
}

/** L2293-2296 verbatim. Floor charge applies per-van AND only when the property is a flat. */
export function getFloorCharge(
  floor: FloorKey,
  isFlat: boolean,
  vanCount: number,
  floorPrices: Record<FloorKey, number> = FLOOR_PRICES,
): number {
  if (!isFlat) return 0;
  return (floorPrices[floor] || 0) * vanCount;
}

/**
 * Transcription of gatherQuoteData() L2301-2342. The DOM reads in the original become
 * the typed QuoteInputs; the arithmetic is identical. Defensive `|| default` fallbacks
 * mirror the live tool's `getRadioValue(...) || 'default'`.
 */
export function computeQuote(i: QuoteInputs, pricing: PricingConfig = DEFAULT_PRICING): QuoteBreakdown {
  const vehicle = i.vehicle || '1luton';
  const packing = i.packing || 'owner';
  // 7.5t lorries: prefer the explicit count; fall back to the legacy boolean (0 or 1).
  const sevenFiveT = i.sevenFiveT ?? (i.has75T ? 1 : 0);
  const has75T = sevenFiveT > 0;
  const transitVans = i.transitVans ?? 0;
  const lutonVanCount = VAN_COUNT[vehicle];
  const vanCount = lutonVanCount + sevenFiveT + transitVans;
  const base = pricing.base[vehicle];
  const packCost = pricing.pack[vehicle][packing];
  const addon75Cost = sevenFiveT * pricing.addon75Base;
  const addon75PackCost = sevenFiveT * pricing.addon75Pack[packing];
  const transitCost = transitVans * pricing.addonTransitBase;
  const days = Math.max(1, Math.floor(i.days ?? 1) || 1);
  const extraDaysCost = (days - 1) * (pricing.extraDayRate ?? 0);

  let mileageCost: number | null = null;
  let totalMiles: number | null = null;
  if (i.deadMiles !== null && i.jobMiles !== null) {
    totalMiles = i.deadMiles + i.jobMiles;
    // Deliberate deviation from the live tool (Peter, 2026-07-08): the mileage
    // charge rounds to the nearest pound so quotes don't carry 80p tails.
    mileageCost = Math.round(totalMiles * pricing.mileageRate);
  }

  const collectAccessM = i.collectAccessM || 0;
  const destAccessM = i.destAccessM || 0;
  const collectAccessCost = getAccessCharge(collectAccessM);
  const destAccessCost = getAccessCharge(destAccessM);

  const collectType = i.collectType || 'house';
  const collectFloor = i.collectFloor || 'ground';
  const destType = i.destType || 'house';
  const destFloor = i.destFloor || 'ground';
  const collectFloorCost = getFloorCharge(collectFloor, collectType === 'flat', vanCount, pricing.floor);
  const destFloorCost = getFloorCharge(destFloor, destType === 'flat', vanCount, pricing.floor);

  const congestion = i.congestion ? vanCount * pricing.congestionPerVan : 0;
  const tolls = i.tolls || 0;
  const parking = i.parking || 0;
  const discount = i.discount || 0;

  const subtotal =
    base +
    packCost +
    addon75Cost +
    addon75PackCost +
    transitCost +
    extraDaysCost +
    (mileageCost || 0) +
    collectAccessCost +
    destAccessCost +
    collectFloorCost +
    destFloorCost +
    congestion +
    tolls +
    parking +
    pricing.adminFee;
  const total = Math.max(0, subtotal - discount);
  const vatEnabled = i.vatEnabled;
  const vatAmount = vatEnabled ? total * 0.2 : 0;
  const grandTotal = total + vatAmount;

  return {
    vehicle,
    packing,
    has75T,
    sevenFiveT,
    transitVans,
    vanCount,
    base,
    packCost,
    addon75Cost,
    addon75PackCost,
    transitCost,
    days,
    extraDaysCost,
    mileageCost,
    totalMiles,
    collectAccessM,
    destAccessM,
    collectAccessCost,
    destAccessCost,
    collectType,
    collectFloor,
    destType,
    destFloor,
    collectFloorCost,
    destFloorCost,
    congestion,
    tolls,
    parking,
    discount,
    subtotal,
    total,
    vatEnabled,
    vatAmount,
    grandTotal,
    adminFee: pricing.adminFee,
  };
}
